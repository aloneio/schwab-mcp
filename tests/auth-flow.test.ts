import assert from 'node:assert/strict'
import test from 'node:test'
import {
	type AuthRequest,
	type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { SchwabHandler } from '../src/auth/handler'
import {
	SchwabAuthService,
	SCHWAB_TOKEN_URL,
	SCHWAB_PREFERENCES_URL,
	type AuthStorage,
} from '../src/auth/service'
import { type Env } from '../types/env'

class MemoryStorage implements AuthStorage {
	values = new Map<string, unknown>()
	async get<T>(key: string): Promise<T | undefined> {
		return structuredClone(this.values.get(key)) as T | undefined
	}
	async put<T>(key: string, value: T): Promise<void> {
		this.values.set(key, structuredClone(value))
	}
	async delete(key: string): Promise<boolean> {
		return this.values.delete(key)
	}
	async deleteAll(): Promise<void> {
		this.values.clear()
	}
	async setAlarm(): Promise<void> {}
}

void test('complete browser authorization keeps concurrent users of one client separate', async () => {
	const previousFetch = globalThis.fetch
	const calls: Array<{ method: string; url: string }> = []
	globalThis.fetch = async (input, init) => {
		const url = String(input)
		calls.push({ url, method: init?.method ?? '' })
		assert.equal(init?.redirect, 'manual')
		if (url === SCHWAB_TOKEN_URL) {
			assert.equal(init?.method, 'POST')
			const form = new URLSearchParams(init.body as string)
			const suffix = form.get('code')
			assert.ok(suffix === 'fixture-a' || suffix === 'fixture-b')
			return Response.json({
				access_token: `access-${suffix}`,
				refresh_token: `refresh-${suffix}`,
				expires_in: 1800,
			})
		}
		assert.equal(url, SCHWAB_PREFERENCES_URL)
		assert.equal(init?.method, 'GET')
		const authorization = new Headers(init.headers).get('Authorization')
		return Response.json({
			streamerInfo: [
				{
					schwabClientCorrelId:
						authorization === 'Bearer access-fixture-a' ? 'user-a' : 'user-b',
				},
			],
		})
	}
	try {
		// The provider has accepted a loopback callback whose ephemeral port differs from registration.
		const authRequest = {
			responseType: 'code',
			clientId: 'one-shared-client',
			redirectUri: 'http://127.0.0.1:54321/callback',
			scope: ['read'],
			state: 'fixture-client-state',
			codeChallenge: 'a'.repeat(43),
			codeChallengeMethod: 'S256',
			issuer: 'https://server.example',
		} as AuthRequest
		const completed: Array<{
			userId: string
			props: Record<string, string>
			request: AuthRequest
			scope: string[]
		}> = []
		const credentials = {
			SCHWAB_CLIENT_ID: 'fixture-schwab-client',
			SCHWAB_CLIENT_SECRET: 'fixture-schwab-secret',
			SCHWAB_REDIRECT_URI: 'https://server.example/callback',
		}
		const objects = new Map<
			string,
			{ storage: MemoryStorage; service: SchwabAuthService }
		>()
		const namespace = {
			idFromName(name: string) {
				return name
			},
			get(id: string) {
				if (!objects.has(id)) {
					const storage = new MemoryStorage()
					objects.set(id, {
						storage,
						service: new SchwabAuthService(
							storage,
							credentials,
							globalThis.fetch,
						),
					})
				}
				return {
					fetch(input: string, init: RequestInit) {
						return objects.get(id)!.service.fetch(new Request(input, init))
					},
				}
			},
		}
		const helpers = {
			async parseAuthRequest() {
				return authRequest
			},
			async lookupClient() {
				return {
					clientId: authRequest.clientId,
					clientName: 'Fixture Research Client',
					redirectUris: ['http://127.0.0.1:49152/callback'],
				}
			},
			async completeAuthorization(options: (typeof completed)[number]) {
				completed.push(options)
				return {
					redirectTo: `${authRequest.redirectUri}?code=fixture-mcp-code`,
				}
			},
		}
		const env = {
			...credentials,
			COOKIE_ENCRYPTION_KEY: 'fixture-browser-signing-secret-32-characters',
			SCHWAB_AUTH: namespace,
			OAUTH_KV: {},
			OAUTH_PROVIDER: helpers,
		} as unknown as Env & { OAUTH_PROVIDER: OAuthHelpers }
		async function begin() {
			const callsBefore = calls.length
			const page = await SchwabHandler.fetch(
				new Request('https://server.example/authorize'),
				env,
			)
			assert.equal(page.status, 200)
			assert.equal(
				calls.length,
				callsBefore,
				'consent rendering never contacts Schwab',
			)
			const cookie = page.headers.get('Set-Cookie')!.split(';')[0]!
			const text = await page.text()
			const transaction = /name="transaction" value="([^"]+)"/.exec(text)?.[1]
			assert.ok(transaction)
			return { cookie, transaction }
		}
		async function approve(
			flow: { cookie: string; transaction: string },
			cookie = flow.cookie,
		) {
			const approval = await SchwabHandler.fetch(
				new Request('https://server.example/authorize', {
					method: 'POST',
					headers: {
						Cookie: cookie,
						Origin: 'https://server.example',
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: new URLSearchParams({
						transaction: flow.transaction,
						decision: 'approve',
					}),
				}),
				env,
			)
			assert.equal(approval.status, 200)
			assert.equal(approval.headers.has('Location'), false)
			const href = /id="continue" href="([^"]+)"/.exec(
				await approval.text(),
			)?.[1]
			assert.ok(href)
			assert.equal(
				new URL(href.replaceAll('&amp;', '&')).searchParams.get('state'),
				flow.transaction,
			)
		}
		const [first, second] = await Promise.all([begin(), begin()])
		const sharedBrowserCookies = `${first.cookie}; ${second.cookie}`
		assert.notEqual(first.cookie.split('=')[0], second.cookie.split('=')[0])
		await Promise.all([
			approve(first, sharedBrowserCookies),
			approve(second, sharedBrowserCookies),
		])
		const callback = (flow: typeof first, code: string) =>
			SchwabHandler.fetch(
				new Request(
					`https://server.example/callback?state=${flow.transaction}&code=${code}`,
					{ headers: { Cookie: sharedBrowserCookies } },
				),
				env,
			)
		const responses = await Promise.all([
			callback(first, 'fixture-a'),
			callback(second, 'fixture-b'),
		])
		assert.ok(responses.every((response) => response.status === 302))
		for (const [index, response] of responses.entries()) {
			assert.match(response.headers.get('Set-Cookie')!, /Max-Age=0$/)
			assert.ok(
				response.headers
					.get('Set-Cookie')!
					.includes([first, second][index]!.transaction),
			)
		}
		assert.deepEqual(completed.map((value) => value.userId).sort(), [
			'user-a',
			'user-b',
		])
		for (const value of completed) {
			assert.deepEqual(value.props, {
				schwabUserId: value.userId,
				clientId: 'one-shared-client',
			})
			assert.deepEqual(value.scope, ['read'])
			assert.deepEqual(value.request, authRequest)
		}
		const tokenA = await objects
			.get('user:user-a')!
			.storage.get<{ accessToken: string }>('tokens')
		const tokenB = await objects
			.get('user:user-b')!
			.storage.get<{ accessToken: string }>('tokens')
		assert.equal(tokenA?.accessToken, 'access-fixture-a')
		assert.equal(tokenB?.accessToken, 'access-fixture-b')
		assert.equal(
			[...objects.keys()].some((key) => key.includes('one-shared-client')),
			false,
		)
		assert.equal((await callback(first, 'fixture-a')).status, 400)
		const cancelled = await begin()
		const denial = await SchwabHandler.fetch(
			new Request('https://server.example/authorize', {
				method: 'POST',
				headers: {
					Cookie: cancelled.cookie,
					Origin: 'https://server.example',
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					transaction: cancelled.transaction,
					decision: 'deny',
				}),
			}),
			env,
		)
		assert.equal(denial.status, 200)
		assert.match(denial.headers.get('Set-Cookie')!, /Max-Age=0$/)
		const denialHref = /id="continue" href="([^"]+)"/.exec(
			await denial.text(),
		)?.[1]
		assert.ok(denialHref)
		const denialLocation = new URL(denialHref.replaceAll('&amp;', '&'))
		assert.equal(denialLocation.searchParams.get('error'), 'access_denied')
		assert.equal(denialLocation.searchParams.get('state'), authRequest.state)
		assert.equal(denialLocation.searchParams.get('iss'), authRequest.issuer)
		assert.equal(calls.filter((call) => call.method === 'POST').length, 2)
		assert.ok(
			calls.every(
				(call) => call.method === 'GET' || call.url === SCHWAB_TOKEN_URL,
			),
		)
	} finally {
		globalThis.fetch = previousFetch
	}
})
