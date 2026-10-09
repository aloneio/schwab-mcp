import {
	type AuthRequest,
	type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import { type ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { type Env } from '../../types/env'
import { getConfig } from '../config'
import { callAuthCoordinator } from './client'
import {
	ensureBrowserBinding,
	requireBrowserBinding,
	requireSameOrigin,
} from './cookies'
import {
	AuthServiceError,
	exchangeSchwabCode,
	lookupSchwabUser,
	oauthRequestSchema,
	type TransactionResult,
} from './service'
import { renderApprovalDialog } from './ui/approvalDialog'

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>()
const transactionIdSchema = z.string().uuid()

app.use('*', async (c, next) => {
	c.header('Cache-Control', 'no-store')
	c.header('Referrer-Policy', 'no-referrer')
	c.header('X-Content-Type-Options', 'nosniff')
	await next()
})

app.onError((error, c) => {
	const safe =
		error instanceof AuthServiceError
			? error
			: new AuthServiceError(
					500,
					'authentication_failed',
					'Unable to complete authorization. Start again.',
				)
	return c.json(
		{
			code: safe.code,
			message: safe.message,
			...(safe.requestId ? { requestId: safe.requestId } : {}),
		},
		safe.status as ContentfulStatusCode,
	)
})

app.get('/authorize', async (c) => {
	const config = getConfig(c.env)
	let parsed: AuthRequest
	try {
		parsed = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw)
	} catch {
		throw new AuthServiceError(
			400,
			'invalid_authorization_request',
			'Invalid client authorization request.',
		)
	}
	const client = await c.env.OAUTH_PROVIDER.lookupClient(parsed.clientId)
	// parseAuthRequest already validates the registered URI, including RFC 8252 loopback ports.
	if (!client)
		throw new AuthServiceError(
			400,
			'invalid_client',
			'Use a registered client and callback URL.',
		)
	const validated = oauthRequestSchema.safeParse({
		...parsed,
		scope: parsed.scope.length ? parsed.scope : ['read'],
	})
	if (!validated.success)
		throw new AuthServiceError(
			400,
			'invalid_authorization_request',
			'This server requires authorization code flow, PKCE S256, and read scope.',
		)
	const transactionId = crypto.randomUUID()
	const browser = await ensureBrowserBinding(
		c.req.raw,
		config.COOKIE_ENCRYPTION_KEY,
	)
	await callAuthCoordinator(
		config,
		`transaction:${transactionId}`,
		'/transaction/create',
		{
			id: transactionId,
			request: validated.data,
			browserBinding: browser.browserBinding,
		},
	)
	return renderApprovalDialog({
		clientName: client.clientName || 'MCP client',
		redirectUri: parsed.redirectUri,
		transactionId,
		cookie: browser.cookie,
	})
})

app.post('/authorize', async (c) => {
	const config = getConfig(c.env)
	requireSameOrigin(c.req.raw)
	const browserBinding = await requireBrowserBinding(
		c.req.raw,
		config.COOKIE_ENCRYPTION_KEY,
	)
	const form = await c.req.formData().catch(() => {
		throw new AuthServiceError(
			400,
			'invalid_approval',
			'Invalid approval form.',
		)
	})
	const transaction = transactionIdSchema.safeParse(form.get('transaction'))
	const decision = form.get('decision')
	if (!transaction.success || (decision !== 'approve' && decision !== 'deny'))
		throw new AuthServiceError(
			400,
			'invalid_approval',
			'Choose whether to approve this connection.',
		)
	if (decision === 'deny') {
		const result = await callAuthCoordinator<TransactionResult>(
			config,
			`transaction:${transaction.data}`,
			'/transaction/cancel',
			{ browserBinding },
		)
		return deniedRedirect(result.request)
	}
	const result = await callAuthCoordinator<{ url: string }>(
		config,
		`transaction:${transaction.data}`,
		'/transaction/approve',
		{ browserBinding },
	)
	return Response.redirect(result.url, 302)
})

function deniedRedirect(request: AuthRequest): Response {
	const url = new URL(request.redirectUri)
	for (const key of ['error', 'error_description', 'error_uri', 'state', 'iss'])
		url.searchParams.delete(key)
	url.searchParams.set('error', 'access_denied')
	if (request.state) url.searchParams.set('state', request.state)
	if (request.issuer) url.searchParams.set('iss', request.issuer)
	return Response.redirect(url.toString(), 302)
}

app.get('/callback', async (c) => {
	const config = getConfig(c.env)
	const state = transactionIdSchema.safeParse(c.req.query('state'))
	if (!state.success)
		throw new AuthServiceError(
			400,
			'invalid_state',
			'Missing or invalid authorization state.',
		)
	const browserBinding = await requireBrowserBinding(
		c.req.raw,
		config.COOKIE_ENCRYPTION_KEY,
	)
	const upstreamDenied = !!c.req.query('error')
	const code = c.req.query('code')
	if (!upstreamDenied && (!code || code.length > 4096))
		throw new AuthServiceError(
			400,
			'missing_code',
			'Schwab did not return a valid authorization code.',
		)
	// Consume before network calls. A failed exchange requires a fresh authorization.
	const transaction = await callAuthCoordinator<TransactionResult>(
		config,
		`transaction:${state.data}`,
		'/transaction/consume',
		{ browserBinding },
	)
	if (upstreamDenied) return deniedRedirect(transaction.request)
	const tokens = await exchangeSchwabCode(config, code!, transaction.verifier)
	const userId = await lookupSchwabUser(tokens.accessToken)
	await callAuthCoordinator(config, `user:${userId}`, '/tokens/save', tokens)
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request: transaction.request,
		userId,
		metadata: { label: 'Schwab read-only connection' },
		scope: ['read'],
		props: { schwabUserId: userId, clientId: transaction.request.clientId },
	})
	return Response.redirect(redirectTo, 302)
})

export { app as SchwabHandler }
