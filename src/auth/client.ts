import { type TokenData } from '@sudowealth/schwab-api'
import { z } from 'zod'
import { type ValidatedEnv } from '../../types/env'
import { AuthServiceError } from './service'

type AuthBinding = Pick<ValidatedEnv, 'SCHWAB_AUTH'>

export async function callAuthCoordinator<T>(
	config: AuthBinding,
	objectName: string,
	path: string,
	body: unknown,
): Promise<T> {
	const id = config.SCHWAB_AUTH.idFromName(objectName)
	let response: Response
	try {
		response = await config.SCHWAB_AUTH.get(id).fetch(
			`https://auth.internal${path}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			},
		)
	} catch {
		throw new AuthServiceError(
			503,
			'auth_unavailable',
			'Authentication storage is temporarily unavailable.',
		)
	}
	if (!response.ok) {
		const parsed = z
			.object({
				code: z.string(),
				message: z.string(),
				requestId: z.string().optional(),
			})
			.safeParse(await response.json().catch(() => null))
		throw new AuthServiceError(
			response.status,
			parsed.success ? parsed.data.code : 'auth_failed',
			parsed.success ? parsed.data.message : 'Authentication failed.',
			parsed.success ? parsed.data.requestId : undefined,
		)
	}
	return (await response.json()) as T
}

export interface RefreshOptions {
	force?: boolean
	/** The bearer rejected by a request, to avoid refreshing a newer credential. */
	accessToken?: string
}

/** All sessions for one Schwab user share the same serialized credential owner. */
export class SchwabTokenProvider {
	private lastAccessToken?: string
	constructor(
		private readonly config: AuthBinding,
		private readonly userId: string,
	) {
		if (!userId)
			throw new AuthServiceError(
				401,
				'reauthorization_required',
				'Reconnect your Schwab account.',
			)
	}

	async getTokenData(): Promise<TokenData> {
		return this.refreshIfNeeded()
	}
	async getAccessToken(): Promise<string> {
		return (await this.getTokenData()).accessToken
	}
	async initialize(): Promise<boolean> {
		await this.getTokenData()
		return true
	}

	async refreshIfNeeded(options: RefreshOptions = {}): Promise<TokenData> {
		const tokens = await callAuthCoordinator<TokenData>(
			this.config,
			`user:${this.userId}`,
			'/tokens/get',
			{
				force: options.force ?? false,
				expectedAccessToken: options.accessToken ?? this.lastAccessToken,
			},
		)
		this.lastAccessToken = tokens.accessToken
		return tokens
	}

	async invalidateIfCurrent(accessToken: string): Promise<void> {
		await callAuthCoordinator(
			this.config,
			`user:${this.userId}`,
			'/tokens/invalidate',
			{ accessToken },
		)
		if (this.lastAccessToken === accessToken) this.lastAccessToken = undefined
	}
}

export function createSchwabTokenProvider(
	config: AuthBinding,
	userId: string,
): SchwabTokenProvider {
	return new SchwabTokenProvider(config, userId)
}
