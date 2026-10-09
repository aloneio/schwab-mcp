import OAuthProvider, { OAuthError } from '@cloudflare/workers-oauth-provider'
import { DurableObject } from 'cloudflare:workers'
import { SchwabHandler, createSchwabTokenProvider } from './auth'
import { AuthServiceError } from './auth/service'
import { getConfig } from './config'
import { createMcpServer } from './mcp/server'
import {
	readSessionOwner,
	sameSessionOwner,
	type SessionOwner,
} from './mcp/session'
import { SchwabSseTransport } from './mcp/transport'
import { createReadOnlySchwabClient } from './shared/schwabReadClient'

export { SchwabAuthCoordinator } from './auth/coordinator'

/** One MCP server per connection. Credentials live exclusively in the user auth DO. */
export class MyMCP extends DurableObject<Env> {
	private owner?: SessionOwner
	private transport?: SchwabSseTransport
	private server?: ReturnType<typeof createMcpServer>

	async open(request: Request, props: unknown): Promise<Response> {
		const owner = readSessionOwner(props)
		if (!owner)
			return new Response('Reconnect and authorize Schwab.', { status: 401 })
		if (this.transport)
			return new Response('Session already connected.', { status: 409 })
		try {
			const config = getConfig(this.env)
			const tokenProvider = createSchwabTokenProvider(
				config,
				owner.schwabUserId,
			)
			if (!(await tokenProvider.initialize()))
				return new Response('Reconnect and authorize Schwab.', { status: 401 })
			this.owner = owner
			this.server = createMcpServer(createReadOnlySchwabClient(tokenProvider))
			this.transport = new SchwabSseTransport(this.ctx.id.toString())
			await this.server.connect(this.transport)
			return this.transport.response
		} catch (error) {
			await this.transport?.close()
			if (error instanceof AuthServiceError)
				return Response.json(
					{
						code: error.code,
						message: error.message,
						requestId: error.requestId,
					},
					{ status: error.status },
				)
			return new Response(
				'Unable to initialize Schwab. Reconnect to try again.',
				{ status: 503 },
			)
		}
	}

	async message(request: Request, props: unknown): Promise<Response> {
		if (!sameSessionOwner(this.owner, readSessionOwner(props)))
			return new Response(
				'MCP session does not belong to this authorization.',
				{ status: 403 },
			)
		if (!this.transport)
			return new Response('Reconnect the MCP session.', { status: 410 })
		return this.transport.accept(request)
	}
}

const apiHandler = {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url)
		const owner = readSessionOwner(ctx.props)
		if (!owner)
			return new Response('Reconnect and authorize Schwab.', { status: 401 })
		const auth = (ctx as ExecutionContext & { auth?: { scope?: string[] } })
			.auth
		if (!auth?.scope?.includes('read'))
			return new Response('Read authorization is required.', {
				status: 403,
				headers: {
					'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="read"',
				},
			})
		if (url.pathname === '/sse' && request.method === 'GET') {
			const object = env.MCP_OBJECT.get(env.MCP_OBJECT.newUniqueId())
			return object.open(request, owner)
		}
		if (url.pathname === '/sse/message' && request.method === 'POST') {
			const id = url.searchParams.get('sessionId')
			if (!id || !/^[a-f0-9]{64}$/i.test(id))
				return new Response('Invalid MCP session.', { status: 400 })
			try {
				return await env.MCP_OBJECT.get(
					env.MCP_OBJECT.idFromString(id),
				).message(request, owner)
			} catch {
				return new Response('Reconnect the MCP session.', { status: 410 })
			}
		}
		return new Response('Not found', { status: 404 })
	},
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		try {
			const config = getConfig(env)
			const resource = new URL('/sse', config.SCHWAB_REDIRECT_URI).href
			if (new URL(request.url).origin !== new URL(resource).origin)
				return new Response('Use the configured MCP server origin.', {
					status: 421,
				})
			return await new OAuthProvider<Env>({
				apiRoute: '/sse',
				apiHandler,
				defaultHandler: SchwabHandler,
				authorizeEndpoint: '/authorize',
				tokenEndpoint: '/token',
				clientRegistrationEndpoint: '/register',
				scopesSupported: ['read'],
				requiredScopes: ['read'],
				resourceMetadata: { resource, resource_name: 'Schwab read-only MCP' },
				tokenExchangeCallback: async ({ props, userId, clientId }) => {
					const owner = readSessionOwner(props)
					if (
						!owner ||
						owner.schwabUserId !== userId ||
						owner.clientId !== clientId
					)
						throw new OAuthError('invalid_grant', {
							description: 'Reconnect and authorize Schwab.',
						})
					try {
						await createSchwabTokenProvider(config, userId).getAccessToken()
					} catch (error) {
						if (error instanceof AuthServiceError && error.status === 401)
							throw new OAuthError('invalid_grant', {
								description: 'Reconnect and authorize Schwab.',
							})
						throw new OAuthError('temporarily_unavailable', {
							description: 'Schwab authentication is temporarily unavailable.',
							statusCode:
								error instanceof AuthServiceError ? error.status : 503,
						})
					}
				},
			}).fetch(request, env, ctx)
		} catch {
			return new Response(
				'Schwab MCP is temporarily unavailable. Check server configuration.',
				{ status: 503 },
			)
		}
	},
}
