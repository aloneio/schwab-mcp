import assert from 'node:assert/strict'
import test from 'node:test'
import { type AuthRequest } from '@cloudflare/workers-oauth-provider'
import { createSchwabTokenProvider } from '../src/auth/client'
import {
	ensureBrowserBinding,
	requireBrowserBinding,
	requireSameOrigin,
} from '../src/auth/cookies'
import {
	AuthServiceError,
	SchwabAuthService,
	SCHWAB_TOKEN_URL,
	SCHWAB_PREFERENCES_URL,
	TRANSACTION_TTL_MS,
	exchangeSchwabCode,
	lookupSchwabUser,
	oauthRequestSchema,
	responseRequestId,
	type AuthStorage,
} from '../src/auth/service'
import { renderApprovalDialog } from '../src/auth/ui/approvalDialog'
import { type ValidatedEnv } from '../types/env'

class MemoryStorage implements AuthStorage {
	values = new Map<string, unknown>()
	alarmAt = 0
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
	async setAlarm(time: number): Promise<void> {
		this.alarmAt = time
	}
}

const credentials = {
	SCHWAB_CLIENT_ID: 'fixture-client',
	SCHWAB_CLIENT_SECRET: 'fixture-secret',
	SCHWAB_REDIRECT_URI: 'https://server.example/callback',
}
const authRequest: AuthRequest = {
	responseType: 'code',
	clientId: 'fixture-mcp-client',
	redirectUri: 'https://client.example/callback',
	scope: ['read'],
	state: 'fixture-state',
	codeChallenge: 'a'.repeat(43),
	codeChallengeMethod: 'S256',
}
const binding = 'a'.repeat(64)
const noNetwork: typeof fetch = async () => {
	throw new Error('No live network is permitted in auth tests')
}

void test('authorization transaction requires approval and is consumed once', async () => {
	const service = new SchwabAuthService(
		new MemoryStorage(),
		credentials,
		noNetwork,
	)
	const id = crypto.randomUUID()
	await service.createTransaction(id, authRequest, binding)
	await assert.rejects(service.consumeTransaction(binding), {
		code: 'approval_required',
	})
	const url = new URL(await service.approveTransaction(binding))
	assert.equal(url.searchParams.get('state'), id)
	assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
	assert.equal(url.searchParams.get('code_challenge')?.length, 43)
	assert.equal(url.searchParams.has('code_verifier'), false)
	const results = await Promise.allSettled([
		service.consumeTransaction(binding),
		service.consumeTransaction(binding),
	])
	assert.equal(
		results.filter((result) => result.status === 'fulfilled').length,
		1,
	)
	const result = results.find((result) => result.status === 'fulfilled')
	assert.deepEqual(
		result?.status === 'fulfilled' ? result.value.request : null,
		authRequest,
	)
})

void test('transactions expire and cancellation consumes a pending request', async () => {
	let now = 1_800_000_000_000
	const service = new SchwabAuthService(
		new MemoryStorage(),
		credentials,
		noNetwork,
		() => now,
	)
	await service.createTransaction(crypto.randomUUID(), authRequest, binding)
	now += TRANSACTION_TTL_MS
	await assert.rejects(service.approveTransaction(binding), {
		code: 'invalid_transaction',
	})
	const other = new SchwabAuthService(
		new MemoryStorage(),
		credentials,
		noNetwork,
	)
	await other.createTransaction(crypto.randomUUID(), authRequest, binding)
	assert.deepEqual(
		(await other.consumeTransaction(binding, true)).request,
		authRequest,
	)
	await assert.rejects(other.approveTransaction(binding), {
		code: 'invalid_transaction',
	})
})

void test('authorization schema allows only read scope and PKCE S256', () => {
	assert.equal(oauthRequestSchema.safeParse(authRequest).success, true)
	assert.equal(
		oauthRequestSchema.safeParse({ ...authRequest, scope: ['write'] }).success,
		false,
	)
	assert.equal(
		oauthRequestSchema.safeParse({
			...authRequest,
			codeChallengeMethod: 'plain',
		}).success,
		false,
	)
})

void test('browser binding is signed and approval requires the page origin', async () => {
	const secret = 'fixture-cookie-signing-key'.repeat(2)
	const session = await ensureBrowserBinding(
		new Request('https://server.example/authorize'),
		secret,
	)
	const request = new Request('https://server.example/authorize', {
		headers: {
			Cookie: session.cookie.split(';')[0]!,
			Origin: 'https://server.example',
		},
	})
	assert.equal(
		await requireBrowserBinding(request, secret),
		session.browserBinding,
	)
	assert.equal(
		(await ensureBrowserBinding(request, secret)).browserBinding,
		session.browserBinding,
	)
	assert.match(session.cookie, /HttpOnly; Secure; SameSite=Lax; Path=\//)
	await assert.rejects(
		requireBrowserBinding(request, 'other-fixture-key'.repeat(2)),
		{ code: 'browser_session_missing' },
	)
	requireSameOrigin(request)
	assert.throws(
		() => requireSameOrigin(new Request('https://server.example/authorize')),
		{ code: 'invalid_origin' },
	)
})

void test('consent page escapes ordinary metadata and never auto-submits', async () => {
	const response = renderApprovalDialog({
		clientName: 'Research & Savings',
		redirectUri: authRequest.redirectUri,
		transactionId: crypto.randomUUID(),
		cookie: 'fixture=value',
	})
	const body = await response.text()
	assert.match(body, /Research &amp; Savings/)
	assert.match(body, /value="approve"/)
	assert.match(body, /value="deny"/)
	assert.doesNotMatch(body, /<script|setInterval|form\.submit/)
	assert.doesNotMatch(
		response.headers.get('Content-Security-Policy') ?? '',
		/unsafe-inline/,
	)
	assert.equal(response.headers.get('Cache-Control'), 'no-store')
})

void test('absolute expiry is stable and concurrent sessions refresh only once', async () => {
	let now = 1_800_000_000_000
	let refreshCalls = 0
	const fetchFixture: typeof fetch = async (input, init) => {
		assert.equal(String(input), SCHWAB_TOKEN_URL)
		assert.equal(init?.method, 'POST')
		assert.equal(init?.redirect, 'manual')
		assert.equal(
			new URLSearchParams(init?.body as string).get('grant_type'),
			'refresh_token',
		)
		refreshCalls++
		await Promise.resolve()
		return Response.json({
			access_token: 'fixture-access-2',
			refresh_token: 'fixture-refresh-2',
			expires_in: 1800,
		})
	}
	const service = new SchwabAuthService(
		new MemoryStorage(),
		credentials,
		fetchFixture,
		() => now,
	)
	const initial = {
		accessToken: 'fixture-access-1',
		refreshToken: 'fixture-refresh-1',
		expiresAt: now + 1800000,
	}
	await service.saveTokens(initial)
	now += 1200000
	assert.equal((await service.getTokens()).expiresAt, initial.expiresAt)
	assert.equal(refreshCalls, 0)
	now += 360000
	const tokens = await Promise.all(
		Array.from({ length: 8 }, () => service.getTokens()),
	)
	assert.equal(refreshCalls, 1)
	assert.ok(
		tokens.every(
			(token) =>
				token.accessToken === 'fixture-access-2' &&
				token.expiresAt === now + 1800000,
		),
	)
	await service.getTokens(true, initial.accessToken)
	assert.equal(
		refreshCalls,
		1,
		'a rejected old bearer must not refresh a newer token',
	)
	const otherUser = new SchwabAuthService(
		new MemoryStorage(),
		credentials,
		noNetwork,
		() => now,
	)
	await assert.rejects(otherUser.getTokens(), {
		code: 'reauthorization_required',
	})
})

void test('revoked refresh credentials require reconnect and return safe errors', async () => {
	let now = 1_800_000_000_000
	let calls = 0
	const service = new SchwabAuthService(
		new MemoryStorage(),
		credentials,
		async () => {
			calls++
			return Response.json(
				{
					error: 'invalid_grant',
					error_description: 'private provider detail',
				},
				{ status: 400, headers: { 'x-request-id': 'fixture-request-id' } },
			)
		},
		() => now,
	)
	await service.saveTokens({
		accessToken: 'fixture-access',
		refreshToken: 'fixture-refresh',
		expiresAt: now + 1000,
	})
	now += 1001
	await assert.rejects(
		service.getTokens(),
		(error) =>
			error instanceof AuthServiceError &&
			error.status === 401 &&
			error.requestId === 'fixture-request-id' &&
			!error.message.includes('private'),
	)
	await assert.rejects(service.getTokens(), {
		code: 'reauthorization_required',
	})
	assert.equal(calls, 1)
})

void test('persistent rejection invalidates the current token but preserves a newer authorization', async () => {
	const now = 1_800_000_000_000
	const service = new SchwabAuthService(
		new MemoryStorage(),
		credentials,
		noNetwork,
		() => now,
	)
	const first = {
		accessToken: 'fixture-first-access',
		refreshToken: 'fixture-first-refresh',
		expiresAt: now + 1800000,
	}
	await service.saveTokens(first)
	await service.invalidateIfCurrent(first.accessToken)
	await assert.rejects(service.getTokens(), {
		status: 401,
		code: 'reauthorization_required',
	})
	const next = {
		accessToken: 'fixture-next-access',
		refreshToken: 'fixture-next-refresh',
		expiresAt: now + 1800000,
	}
	await Promise.all([
		service.saveTokens(next),
		service.invalidateIfCurrent(first.accessToken),
	])
	assert.deepEqual(await service.getTokens(), next)
	const invalidation = await service.fetch(
		new Request('https://auth.internal/tokens/invalidate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ accessToken: next.accessToken }),
		}),
	)
	assert.equal(invalidation.status, 200)
	await assert.rejects(service.getTokens(), {
		status: 401,
		code: 'reauthorization_required',
	})
})

void test('Schwab correlation request IDs take precedence over generic request headers', () => {
	assert.equal(
		responseRequestId(
			new Response(null, {
				headers: {
					'schwab-client-correl-id': 'fixture-schwab-request',
					'x-request-id': 'fixture-generic-request',
				},
			}),
		),
		'fixture-schwab-request',
	)
})

void test('token exchange and user identity call only fixed Schwab endpoints', async () => {
	const calls: Array<{ url: string; method: string }> = []
	const fixtureFetch: typeof fetch = async (input, init) => {
		calls.push({ url: String(input), method: init?.method ?? '' })
		assert.equal(init?.redirect, 'manual')
		if (String(input) === SCHWAB_TOKEN_URL) {
			const form = new URLSearchParams(init?.body as string)
			assert.equal(form.get('redirect_uri'), credentials.SCHWAB_REDIRECT_URI)
			assert.equal(form.get('code_verifier'), 'fixture-verifier')
			return Response.json({
				access_token: 'fixture-access',
				refresh_token: 'fixture-refresh',
				expires_in: 1800,
			})
		}
		assert.equal(String(input), SCHWAB_PREFERENCES_URL)
		return Response.json({
			streamerInfo: [{ schwabClientCorrelId: 'fixture-user' }],
		})
	}
	const tokens = await exchangeSchwabCode(
		credentials,
		'fixture-code',
		'fixture-verifier',
		fixtureFetch,
	)
	assert.equal(
		await lookupSchwabUser(tokens.accessToken, fixtureFetch),
		'fixture-user',
	)
	assert.deepEqual(
		calls.map((call) => call.method),
		['POST', 'GET'],
	)
})

void test('authentication requests cancel redirects without following them', async () => {
	let calls = 0
	let cancelled = 0
	const redirectFixture: typeof fetch = async (_input, init) => {
		calls++
		assert.equal(init?.redirect, 'manual')
		return new Response(
			new ReadableStream({
				cancel() {
					cancelled++
				},
			}),
			{
				status: 301,
				headers: {
					Location: 'https://redirect.example/unused',
					'schwab-client-correl-id': 'fixture-redirect-id',
				},
			},
		)
	}
	for (const operation of [
		() =>
			exchangeSchwabCode(
				credentials,
				'fixture-code',
				'fixture-verifier',
				redirectFixture,
			),
		() => lookupSchwabUser('fixture-access', redirectFixture),
	]) {
		await assert.rejects(
			operation(),
			(error: unknown) =>
				error instanceof AuthServiceError &&
				error.status === 502 &&
				error.code === 'upstream_redirect' &&
				error.requestId === 'fixture-redirect-id',
		)
	}
	assert.equal(calls, 2)
	assert.equal(cancelled, 2)
})

void test('provider uses only the user object and forwards the rejected bearer', async () => {
	const seen: Array<{ name: string; path: string; body: unknown }> = []
	let name = ''
	const config = {
		SCHWAB_AUTH: {
			idFromName(value: string) {
				name = value
				return value
			},
			get() {
				return {
					async fetch(input: string, init: RequestInit) {
						seen.push({
							name,
							path: new URL(input).pathname,
							body: JSON.parse(init.body as string),
						})
						return Response.json({
							accessToken: 'fixture-access',
							refreshToken: 'fixture-refresh',
							expiresAt: Date.now() + 1800000,
						})
					},
				}
			},
		},
	} as unknown as Pick<ValidatedEnv, 'SCHWAB_AUTH'>
	const provider = createSchwabTokenProvider(config, 'fixture-user')
	assert.equal(await provider.initialize(), true)
	await provider.refreshIfNeeded({
		force: true,
		accessToken: 'fixture-rejected-access',
	})
	assert.ok(
		seen.every(
			(call) =>
				call.name === 'user:fixture-user' && call.path === '/tokens/get',
		),
	)
	assert.deepEqual(seen[1]?.body, {
		force: true,
		expectedAccessToken: 'fixture-rejected-access',
	})
	await provider.invalidateIfCurrent('fixture-access')
	assert.deepEqual(seen[2], {
		name: 'user:fixture-user',
		path: '/tokens/invalidate',
		body: { accessToken: 'fixture-access' },
	})
})
