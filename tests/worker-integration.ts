import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
	Miniflare,
	Response as LocalResponse,
	convertV4MiniflareOptions,
} from 'miniflare'

const origin = 'https://worker.test'
const resource = `${origin}/sse`
const redirectUri = 'http://localhost:32123/callback'
const scriptPath = process.env.WORKER_BUNDLE
	? resolve(process.env.WORKER_BUNDLE)
	: fileURLToPath(new URL('../.wrangler/integration/index.js', import.meta.url))

/** Every outbound request is handled here; this suite cannot call live Schwab. */
await test(
	'real Worker OAuth provider, Durable Objects and SSE work with a fixture upstream',
	{ timeout: 90_000 },
	async () => {
		assert.ok(
			existsSync(scriptPath),
			'Build the Worker with npm run test:integration or set WORKER_BUNDLE',
		)
		const outbound: Array<{ method: string; path: string }> = []
		let upstreamChallenge = ''
		const mf = new Miniflare(
			convertV4MiniflareOptions({
				modules: true,
				// A complete Wrangler bundle has only runtime imports. Inline it so an
				// alternate WORKER_BUNDLE outside this project cannot affect module roots.
				script: readFileSync(scriptPath, 'utf8'),
				compatibilityDate: '2025-04-17',
				compatibilityFlags: ['nodejs_compat'],
				kvNamespaces: ['OAUTH_KV'],
				durableObjects: {
					MCP_OBJECT: { className: 'MyMCP', useSQLite: true },
					SCHWAB_AUTH: { className: 'SchwabAuthCoordinator', useSQLite: true },
				},
				bindings: {
					SCHWAB_CLIENT_ID: 'fixture-schwab-app',
					SCHWAB_CLIENT_SECRET: 'fixture-schwab-secret',
					SCHWAB_REDIRECT_URI: `${origin}/callback`,
					COOKIE_ENCRYPTION_KEY: 'fixture-signing-key-32-bytes-minimum-value',
					LOG_LEVEL: 'error',
				},
				outboundService: async (request) => {
					const url = new URL(request.url)
					outbound.push({ method: request.method, path: url.pathname })
					assert.equal(
						url.origin,
						'https://api.schwabapi.com',
						'Unexpected upstream origin',
					)
					if (url.pathname === '/v1/oauth/token') {
						assert.equal(request.method, 'POST')
						const body = new URLSearchParams(await request.text())
						assert.equal(body.get('grant_type'), 'authorization_code')
						assert.equal(body.get('redirect_uri'), `${origin}/callback`)
						assert.equal(body.get('code'), 'fixture-schwab-code')
						assert.equal(
							createHash('sha256')
								.update(body.get('code_verifier') ?? '')
								.digest('base64url'),
							upstreamChallenge,
						)
						return LocalResponse.json({
							access_token: 'fixture-schwab-access',
							refresh_token: 'fixture-schwab-refresh',
							expires_in: 1800,
						})
					}
					assert.equal(request.method, 'GET')
					assert.equal(
						request.headers.get('Authorization'),
						'Bearer fixture-schwab-access',
					)
					if (url.pathname === '/trader/v1/userPreference') {
						return LocalResponse.json({
							streamerInfo: [{ schwabClientCorrelId: 'fixture-user' }],
						})
					}
					if (url.pathname === '/marketdata/v1/quotes') {
						assert.equal(url.searchParams.get('symbols'), 'AAPL')
						return LocalResponse.json({
							AAPL: { symbol: 'AAPL', quote: { lastPrice: 123.45 } },
						})
					}
					throw new Error(
						`Unexpected fixture request: ${request.method} ${url.pathname}`,
					)
				},
			}),
		)
		let closeStream: (() => Promise<void>) | undefined
		try {
			const metadata = await mf.dispatchFetch(
				`${origin}/.well-known/oauth-protected-resource/sse`,
			)
			assert.equal(metadata.status, 200)
			assert.deepEqual(
				((await metadata.json()) as { resource: string }).resource,
				resource,
			)
			const issuer = await mf.dispatchFetch(
				`${origin}/.well-known/oauth-authorization-server`,
			)
			assert.equal(issuer.status, 200)
			assert.equal(((await issuer.json()) as { issuer: string }).issuer, origin)
			const unauthenticated = await mf.dispatchFetch(resource)
			assert.equal(unauthenticated.status, 401)
			assert.match(
				unauthenticated.headers.get('WWW-Authenticate') ?? '',
				/oauth-protected-resource\/sse/,
			)

			const registration = await mf.dispatchFetch(`${origin}/register`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					client_name: 'Integration fixture',
					redirect_uris: ['http://localhost:30000/callback'],
					grant_types: ['authorization_code', 'refresh_token'],
					response_types: ['code'],
					token_endpoint_auth_method: 'none',
				}),
			})
			assert.equal(registration.status, 201, await registration.clone().text())
			const client = (await registration.json()) as { client_id: string }
			assert.ok(client.client_id)
			const verifier = randomBytes(32).toString('base64url')
			const authorize = new URL(`${origin}/authorize`)
			authorize.search = new URLSearchParams({
				response_type: 'code',
				client_id: client.client_id,
				redirect_uri: redirectUri,
				scope: 'read',
				state: 'fixture-client-state',
				code_challenge: createHash('sha256')
					.update(verifier)
					.digest('base64url'),
				code_challenge_method: 'S256',
				resource,
			}).toString()
			const consent = await mf.dispatchFetch(authorize)
			assert.equal(consent.status, 200, await consent.clone().text())
			const cookie = consent.headers.get('Set-Cookie')?.split(';')[0]
			assert.ok(cookie)
			const transaction = /name="transaction" value="([^"]+)"/.exec(
				await consent.text(),
			)?.[1]
			assert.ok(transaction)
			const approval = await mf.dispatchFetch(`${origin}/authorize`, {
				method: 'POST',
				redirect: 'manual',
				headers: {
					Cookie: cookie,
					Origin: origin,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					transaction,
					decision: 'approve',
				}).toString(),
			})
			assert.equal(approval.status, 302, await approval.clone().text())
			const upstream = new URL(approval.headers.get('Location')!)
			assert.equal(upstream.origin, 'https://api.schwabapi.com')
			upstreamChallenge = upstream.searchParams.get('code_challenge')!
			const callback = await mf.dispatchFetch(
				`${origin}/callback?${new URLSearchParams({ state: upstream.searchParams.get('state')!, code: 'fixture-schwab-code' })}`,
				{ headers: { Cookie: cookie }, redirect: 'manual' },
			)
			assert.equal(callback.status, 302, await callback.clone().text())
			const clientCallback = new URL(callback.headers.get('Location')!)
			assert.equal(clientCallback.origin, new URL(redirectUri).origin)
			assert.equal(
				clientCallback.searchParams.get('state'),
				'fixture-client-state',
			)
			assert.equal(clientCallback.searchParams.get('iss'), origin)
			const token = await mf.dispatchFetch(`${origin}/token`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					code: clientCallback.searchParams.get('code')!,
					code_verifier: verifier,
					client_id: client.client_id,
					redirect_uri: redirectUri,
					resource,
				}).toString(),
			})
			assert.equal(token.status, 200, await token.clone().text())
			const credentials = (await token.json()) as {
				access_token: string
				refresh_token: string
			}
			assert.ok(credentials.access_token)
			assert.ok(credentials.refresh_token)

			const stream = await mf.dispatchFetch(resource, {
				headers: { Authorization: `Bearer ${credentials.access_token}` },
			})
			assert.equal(
				stream.status,
				200,
				await (stream.status !== 200 ? stream.text() : Promise.resolve('')),
			)
			assert.match(
				stream.headers.get('Content-Type') ?? '',
				/text\/event-stream/,
			)
			const reader = stream.body!.getReader()
			closeStream = async () => {
				await reader.cancel()
			}
			const decoder = new TextDecoder()
			let pending = ''
			const event = async () => {
				while (true) {
					const boundary = pending.indexOf('\n\n')
					if (boundary >= 0) {
						const frame = pending.slice(0, boundary)
						pending = pending.slice(boundary + 2)
						if (!frame.startsWith(':')) return frame
						continue
					}
					const chunk = await reader.read()
					assert.equal(chunk.done, false, 'SSE stream ended unexpectedly')
					pending += decoder.decode(chunk.value, { stream: true })
				}
			}
			const endpoint = /data: (.+)/.exec(await event())?.[1]
			assert.ok(endpoint?.startsWith('/sse/message?sessionId='))
			const post = async (message: unknown) => {
				const result = await mf.dispatchFetch(new URL(endpoint!, origin), {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${credentials.access_token}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(message),
				})
				assert.equal(result.status, 202, await result.text())
			}
			const rpc = async (id: number, method: string, params: unknown) => {
				await post({ jsonrpc: '2.0', id, method, params })
				const frame = await event()
				const data = JSON.parse(/data: (.+)/.exec(frame)?.[1] ?? '') as {
					id: number
					error?: unknown
					result: unknown
				}
				assert.equal(data.id, id)
				assert.equal(data.error, undefined)
				return data.result
			}
			const initialized = (await rpc(1, 'initialize', {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'fixture-client', version: '1.0.0' },
			})) as { serverInfo: { name: string } }
			assert.equal(initialized.serverInfo.name, 'Schwab MCP')
			await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
			const tools = (await rpc(2, 'tools/list', {})) as {
				tools: Array<{ name: string }>
			}
			assert.ok(tools.tools.some((tool) => tool.name === 'getQuotes'))
			const status = await rpc(3, 'tools/call', {
				name: 'status',
				arguments: {},
			})
			assert.match(JSON.stringify(status), /read-only/)
			const quotes = (await rpc(4, 'tools/call', {
				name: 'getQuotes',
				arguments: { symbols: ['AAPL'] },
			})) as { isError?: boolean }
			assert.notEqual(quotes.isError, true, JSON.stringify(quotes))
			assert.match(JSON.stringify(quotes), /123\.45/)
			assert.deepEqual(outbound, [
				{ method: 'POST', path: '/v1/oauth/token' },
				{ method: 'GET', path: '/trader/v1/userPreference' },
				{ method: 'GET', path: '/marketdata/v1/quotes' },
			])

			// Invalidating fixture credentials must force a fresh authorization when
			// the real OAuth provider next processes the client's refresh token.
			const namespace = await mf.getDurableObjectNamespace('SCHWAB_AUTH')
			const user = namespace.get(namespace.idFromName('user:fixture-user'))
			const invalidated = await user.fetch(
				'https://auth.internal/tokens/invalidate',
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ accessToken: 'fixture-schwab-access' }),
				},
			)
			assert.equal(invalidated.status, 200)
			const refresh = await mf.dispatchFetch(`${origin}/token`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: credentials.refresh_token,
					client_id: client.client_id,
					resource,
				}).toString(),
			})
			assert.equal(refresh.status, 400, await refresh.clone().text())
			assert.equal(
				((await refresh.json()) as { error: string }).error,
				'invalid_grant',
			)
		} finally {
			await closeStream?.()
			await mf.dispose()
		}
	},
)
