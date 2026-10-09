import { z } from 'zod'
import {
	AuthServiceError,
	base64url,
	randomToken,
	sha256,
	TRANSACTION_TTL_MS,
} from './service'

const COOKIE_PREFIX = '__Host-schwab-oauth-'
const COOKIE_ATTRIBUTES = 'HttpOnly; Secure; SameSite=Lax; Path=/'

function cookieName(transactionId: string): string {
	return `${COOKIE_PREFIX}${z.string().uuid().parse(transactionId)}`
}

async function signingKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	)
}

/** Each authorization has its own cookie, so concurrent first-time tabs coexist. */
export async function createBrowserBinding(
	transactionId: string,
	secret: string,
	now: () => number = Date.now,
): Promise<{ browserBinding: string; cookie: string }> {
	const name = cookieName(transactionId)
	const nonce = randomToken()
	const expiresAt = now() + TRANSACTION_TTL_MS
	const payload = `${transactionId}.${expiresAt}.${nonce}`
	const signature = base64url(
		new Uint8Array(
			await crypto.subtle.sign(
				'HMAC',
				await signingKey(secret),
				new TextEncoder().encode(payload),
			),
		),
	)
	return {
		browserBinding: await sha256(payload),
		cookie: `${name}=${expiresAt}.${nonce}.${signature}; ${COOKIE_ATTRIBUTES}; Max-Age=${TRANSACTION_TTL_MS / 1000}`,
	}
}

export function clearBrowserBinding(transactionId: string): string {
	return `${cookieName(transactionId)}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`
}

export async function requireBrowserBinding(
	request: Request,
	transactionId: string,
	secret: string,
	now: () => number = Date.now,
): Promise<string> {
	const name = cookieName(transactionId)
	const cookie = request.headers
		.get('Cookie')
		?.split(';')
		.map((value) => value.trim())
		.find((value) => value.startsWith(`${name}=`))
		?.slice(name.length + 1)
	const parts = /^(\d{13})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(
		cookie ?? '',
	)
	if (parts && Number(parts[1]) > now()) {
		const expiresAt = parts[1]!
		const nonce = parts[2]!
		const signature = parts[3]!
		const payload = `${transactionId}.${expiresAt}.${nonce}`
		try {
			const bytes = Uint8Array.from(
				atob(signature.replace(/-/g, '+').replace(/_/g, '/') + '='),
				(char) => char.charCodeAt(0),
			)
			if (
				await crypto.subtle.verify(
					'HMAC',
					await signingKey(secret),
					bytes,
					new TextEncoder().encode(payload),
				)
			)
				return sha256(payload)
		} catch {
			// Malformed or unverifiable cookies are an expired browser session.
		}
	}
	throw new AuthServiceError(
		400,
		'browser_session_missing',
		'This browser authorization session expired. Start again.',
	)
}

export function requireSameOrigin(request: Request): void {
	if (request.headers.get('Origin') !== new URL(request.url).origin) {
		throw new AuthServiceError(
			403,
			'invalid_origin',
			'Approval must be submitted from this authorization page.',
		)
	}
}
