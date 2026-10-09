import { type AuthRequest } from '@cloudflare/workers-oauth-provider'
import { type TokenData } from '@sudowealth/schwab-api'
import { z } from 'zod'

export const SCHWAB_TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token'
export const SCHWAB_AUTHORIZE_URL =
	'https://api.schwabapi.com/v1/oauth/authorize'
export const SCHWAB_PREFERENCES_URL =
	'https://api.schwabapi.com/trader/v1/userPreference'
export const TRANSACTION_TTL_MS = 10 * 60 * 1000
const TOKEN_RETENTION_MS = 31 * 24 * 60 * 60 * 1000
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000

export interface AuthStorage {
	get<T>(key: string): Promise<T | undefined>
	put<T>(key: string, value: T): Promise<void>
	delete(key: string): Promise<boolean>
	deleteAll(): Promise<void>
	setAlarm(time: number): Promise<void>
}

export interface OAuthCredentials {
	SCHWAB_CLIENT_ID: string
	SCHWAB_CLIENT_SECRET: string
	SCHWAB_REDIRECT_URI: string
}

export class AuthServiceError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
		public readonly requestId?: string,
	) {
		super(message)
		this.name = 'AuthServiceError'
	}
}

export const oauthRequestSchema = z
	.object({
		responseType: z.literal('code'),
		clientId: z.string().min(1).max(1024),
		redirectUri: z.string().url().max(4096),
		scope: z.array(z.literal('read')).min(1).max(1),
		state: z.string().max(4096),
		codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
		codeChallengeMethod: z.literal('S256'),
	})
	.passthrough()

const transactionIdSchema = z.string().uuid()
const bindingSchema = z.string().regex(/^[a-f0-9]{64}$/)
const tokenSchema = z.object({
	accessToken: z.string().min(1).max(16384),
	refreshToken: z.string().min(1).max(16384),
	expiresAt: z.number().finite().positive(),
})
const storedTokenSchema = tokenSchema.extend({
	retainUntil: z.number().finite().positive(),
})
const oauthTokenResponseSchema = z.object({
	access_token: z.string().min(1).max(16384),
	refresh_token: z.string().min(1).max(16384).optional(),
	expires_in: z.number().int().positive().max(86400),
	token_type: z.string().optional(),
})

interface OAuthTransaction {
	id: string
	request: AuthRequest
	browserBinding: string
	verifier: string
	expiresAt: number
	approved: boolean
}

export interface TransactionResult {
	request: AuthRequest
	verifier: string
}

export function randomToken(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
}

export async function sha256(value: string): Promise<string> {
	const bytes = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
	)
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	)
}

export function responseRequestId(response: Response): string | undefined {
	const value =
		response.headers.get('schwab-client-correl-id') ??
		response.headers.get('x-request-id') ??
		response.headers.get('request-id')
	return value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json()
	} catch {
		return null
	}
}

/** Only the fixed Schwab token endpoint may receive OAuth credentials. */
export async function requestSchwabToken(
	credentials: OAuthCredentials,
	parameters: URLSearchParams,
	fetchImpl: typeof fetch = fetch,
	now: () => number = Date.now,
	previousRefreshToken?: string,
): Promise<TokenData> {
	let response: Response
	try {
		response = await fetchImpl(SCHWAB_TOKEN_URL, {
			method: 'POST',
			redirect: 'manual',
			signal: AbortSignal.timeout(15000),
			headers: {
				Authorization: `Basic ${btoa(`${credentials.SCHWAB_CLIENT_ID}:${credentials.SCHWAB_CLIENT_SECRET}`)}`,
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json',
			},
			body: parameters.toString(),
		})
	} catch {
		throw new AuthServiceError(
			502,
			'oauth_unavailable',
			'Schwab authentication is temporarily unavailable.',
		)
	}
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel()
		throw new AuthServiceError(
			502,
			'upstream_redirect',
			'Schwab authentication returned an unexpected redirect.',
			responseRequestId(response),
		)
	}
	const body = await readJson(response)
	if (!response.ok) {
		const invalidGrant = z
			.object({ error: z.literal('invalid_grant') })
			.safeParse(body).success
		throw new AuthServiceError(
			invalidGrant ? 401 : response.status === 429 ? 429 : 502,
			invalidGrant ? 'reauthorization_required' : 'oauth_failed',
			invalidGrant
				? 'Reconnect your Schwab account.'
				: 'Schwab authentication failed.',
			responseRequestId(response),
		)
	}
	const parsed = oauthTokenResponseSchema.safeParse(body)
	if (
		!parsed.success ||
		(!parsed.data.refresh_token && !previousRefreshToken)
	) {
		throw new AuthServiceError(
			502,
			'invalid_token_response',
			'Schwab returned an invalid token response.',
			responseRequestId(response),
		)
	}
	return {
		accessToken: parsed.data.access_token,
		refreshToken: parsed.data.refresh_token ?? previousRefreshToken!,
		expiresAt: now() + parsed.data.expires_in * 1000,
	}
}

export async function exchangeSchwabCode(
	credentials: OAuthCredentials,
	code: string,
	verifier: string,
	fetchImpl: typeof fetch = fetch,
): Promise<TokenData> {
	if (!code || code.length > 4096)
		throw new AuthServiceError(
			400,
			'invalid_code',
			'Missing or invalid authorization code.',
		)
	return requestSchwabToken(
		credentials,
		new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: credentials.SCHWAB_REDIRECT_URI,
			code_verifier: verifier,
		}),
		fetchImpl,
	)
}

/** A fixed GET request; this helper cannot submit orders or proxy arbitrary URLs. */
export async function lookupSchwabUser(
	accessToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	let response: Response
	try {
		response = await fetchImpl(SCHWAB_PREFERENCES_URL, {
			method: 'GET',
			redirect: 'manual',
			signal: AbortSignal.timeout(15000),
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: 'application/json',
			},
		})
	} catch {
		throw new AuthServiceError(
			502,
			'profile_unavailable',
			'Unable to retrieve your Schwab profile.',
		)
	}
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel()
		throw new AuthServiceError(
			502,
			'upstream_redirect',
			'Schwab returned an unexpected profile redirect.',
			responseRequestId(response),
		)
	}
	if (!response.ok)
		throw new AuthServiceError(
			response.status === 401 ? 401 : 502,
			'profile_failed',
			'Unable to retrieve your Schwab profile.',
			responseRequestId(response),
		)
	const parsed = z
		.object({
			streamerInfo: z
				.array(z.object({ schwabClientCorrelId: z.string().min(1).max(256) }))
				.min(1),
		})
		.safeParse(await readJson(response))
	if (!parsed.success)
		throw new AuthServiceError(
			502,
			'invalid_profile',
			'Schwab did not return a usable user identity.',
			responseRequestId(response),
		)
	return parsed.data.streamerInfo[0]!.schwabClientCorrelId
}

/** Runs inside one Durable Object. The queue spans network awaits as well as storage. */
export class SchwabAuthService {
	private mutationTail: Promise<void> = Promise.resolve()
	constructor(
		private readonly storage: AuthStorage,
		private readonly credentials: OAuthCredentials,
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
	) {}

	private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.mutationTail
		let release!: () => void
		this.mutationTail = new Promise<void>((resolve) => {
			release = resolve
		})
		await previous
		try {
			return await operation()
		} finally {
			release()
		}
	}

	async createTransaction(
		id: string,
		request: AuthRequest,
		browserBinding: string,
	): Promise<void> {
		return this.exclusive(async () => {
			transactionIdSchema.parse(id)
			bindingSchema.parse(browserBinding)
			const validated = oauthRequestSchema.parse(request) as AuthRequest
			if (await this.storage.get('transaction'))
				throw new AuthServiceError(
					409,
					'transaction_exists',
					'Authorization has already started.',
				)
			const expiresAt = this.now() + TRANSACTION_TTL_MS
			await this.storage.put<OAuthTransaction>('transaction', {
				id,
				request: validated,
				browserBinding,
				verifier: randomToken(),
				expiresAt,
				approved: false,
			})
			await this.storage.setAlarm(expiresAt)
		})
	}

	private async transaction(browserBinding: string): Promise<OAuthTransaction> {
		const transaction = await this.storage.get<OAuthTransaction>('transaction')
		if (
			!transaction ||
			transaction.expiresAt <= this.now() ||
			transaction.browserBinding !== browserBinding
		) {
			throw new AuthServiceError(
				400,
				'invalid_transaction',
				'Authorization expired or belongs to a different browser. Start again.',
			)
		}
		return transaction
	}

	async approveTransaction(browserBinding: string): Promise<string> {
		return this.exclusive(async () => {
			const transaction = await this.transaction(browserBinding)
			if (transaction.approved)
				throw new AuthServiceError(
					400,
					'already_approved',
					'This authorization has already been approved.',
				)
			const challenge = base64url(
				new Uint8Array(
					await crypto.subtle.digest(
						'SHA-256',
						new TextEncoder().encode(transaction.verifier),
					),
				),
			)
			transaction.approved = true
			await this.storage.put('transaction', transaction)
			const url = new URL(SCHWAB_AUTHORIZE_URL)
			url.search = new URLSearchParams({
				client_id: this.credentials.SCHWAB_CLIENT_ID,
				response_type: 'code',
				redirect_uri: this.credentials.SCHWAB_REDIRECT_URI,
				scope: 'api offline_access',
				state: transaction.id,
				code_challenge: challenge,
				code_challenge_method: 'S256',
			}).toString()
			return url.toString()
		})
	}

	async consumeTransaction(
		browserBinding: string,
		denied = false,
	): Promise<TransactionResult> {
		return this.exclusive(async () => {
			const transaction = await this.transaction(browserBinding)
			if (!denied && !transaction.approved)
				throw new AuthServiceError(
					400,
					'approval_required',
					'Approve this connection before continuing.',
				)
			await this.storage.delete('transaction')
			return { request: transaction.request, verifier: transaction.verifier }
		})
	}

	async saveTokens(tokens: TokenData): Promise<void> {
		return this.exclusive(async () => {
			const validated = tokenSchema.parse(tokens)
			if (validated.expiresAt <= this.now())
				throw new AuthServiceError(
					400,
					'expired_tokens',
					'Cannot store expired credentials.',
				)
			const retainUntil = this.now() + TOKEN_RETENTION_MS
			await this.storage.put('tokens', { ...validated, retainUntil })
			await this.storage.setAlarm(retainUntil)
		})
	}

	async getTokens(
		force = false,
		expectedAccessToken?: string,
	): Promise<TokenData> {
		return this.exclusive(async () => {
			const stored = storedTokenSchema.safeParse(
				await this.storage.get('tokens'),
			)
			if (!stored.success || stored.data.retainUntil <= this.now())
				throw new AuthServiceError(
					401,
					'reauthorization_required',
					'Reconnect your Schwab account.',
				)
			const current = stored.data
			const forceCurrent = force && expectedAccessToken === current.accessToken
			if (
				!forceCurrent &&
				current.expiresAt > this.now() + REFRESH_THRESHOLD_MS
			)
				return tokenSchema.parse(current)
			try {
				const refreshed = await requestSchwabToken(
					this.credentials,
					new URLSearchParams({
						grant_type: 'refresh_token',
						refresh_token: current.refreshToken,
					}),
					this.fetchImpl,
					this.now,
					current.refreshToken,
				)
				const retainUntil = this.now() + TOKEN_RETENTION_MS
				await this.storage.put('tokens', { ...refreshed, retainUntil })
				await this.storage.setAlarm(retainUntil)
				return refreshed
			} catch (error) {
				if (
					error instanceof AuthServiceError &&
					error.code === 'reauthorization_required'
				)
					await this.storage.delete('tokens')
				throw error
			}
		})
	}

	async invalidateIfCurrent(accessToken: string): Promise<void> {
		await this.exclusive(async () => {
			const stored = storedTokenSchema.safeParse(
				await this.storage.get('tokens'),
			)
			// A late failure from an older request must not remove a newer authorization.
			if (stored.success && stored.data.accessToken === accessToken)
				await this.storage.delete('tokens')
		})
	}

	async alarm(): Promise<void> {
		await this.exclusive(async () => {
			const transaction =
				await this.storage.get<OAuthTransaction>('transaction')
			const tokens = storedTokenSchema.safeParse(
				await this.storage.get('tokens'),
			)
			const deadlines: number[] = []
			if (transaction) {
				if (transaction.expiresAt <= this.now())
					await this.storage.delete('transaction')
				else deadlines.push(transaction.expiresAt)
			}
			if (tokens.success) {
				if (tokens.data.retainUntil <= this.now())
					await this.storage.delete('tokens')
				else deadlines.push(tokens.data.retainUntil)
			}
			if (deadlines.length) await this.storage.setAlarm(Math.min(...deadlines))
		})
	}

	/** This handler is reachable only through the internal Durable Object binding. */
	async fetch(request: Request): Promise<Response> {
		try {
			if (request.method !== 'POST') return new Response(null, { status: 405 })
			const body = await request.json()
			const path = new URL(request.url).pathname
			if (path === '/transaction/create') {
				const input = z
					.object({
						id: transactionIdSchema,
						request: oauthRequestSchema,
						browserBinding: bindingSchema,
					})
					.parse(body)
				await this.createTransaction(
					input.id,
					input.request as AuthRequest,
					input.browserBinding,
				)
				return Response.json({ ok: true })
			}
			if (
				path === '/transaction/approve' ||
				path === '/transaction/consume' ||
				path === '/transaction/cancel'
			) {
				const input = z.object({ browserBinding: bindingSchema }).parse(body)
				return Response.json(
					path.endsWith('/approve')
						? { url: await this.approveTransaction(input.browserBinding) }
						: await this.consumeTransaction(
								input.browserBinding,
								path.endsWith('/cancel'),
							),
				)
			}
			if (path === '/tokens/save') {
				await this.saveTokens(tokenSchema.parse(body))
				return Response.json({ ok: true })
			}
			if (path === '/tokens/get') {
				const input = z
					.object({
						force: z.boolean().optional(),
						expectedAccessToken: z.string().optional(),
					})
					.parse(body)
				return Response.json(
					await this.getTokens(input.force, input.expectedAccessToken),
				)
			}
			if (path === '/tokens/invalidate') {
				const input = z
					.object({ accessToken: z.string().min(1).max(16384) })
					.parse(body)
				await this.invalidateIfCurrent(input.accessToken)
				return Response.json({ ok: true })
			}
			return new Response(null, { status: 404 })
		} catch (error) {
			const safe =
				error instanceof AuthServiceError
					? error
					: error instanceof z.ZodError || error instanceof SyntaxError
						? new AuthServiceError(
								400,
								'invalid_request',
								'Invalid authentication request.',
							)
						: new AuthServiceError(
								500,
								'auth_unavailable',
								'Authentication storage is temporarily unavailable.',
							)
			return Response.json(
				{ code: safe.code, message: safe.message, requestId: safe.requestId },
				{ status: safe.status },
			)
		}
	}
}
