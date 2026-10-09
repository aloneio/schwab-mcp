import { AuthServiceError, base64url, randomToken, sha256 } from './service'

const COOKIE_NAME = '__Host-schwab-oauth'

async function signingKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	)
}

async function readBrowserNonce(
	request: Request,
	secret: string,
): Promise<string | null> {
	const cookie = request.headers
		.get('Cookie')
		?.split(';')
		.map((value) => value.trim())
		.find((value) => value.startsWith(`${COOKIE_NAME}=`))
		?.slice(COOKIE_NAME.length + 1)
	if (!cookie || !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(cookie))
		return null
	const [nonce, signature] = cookie.split('.') as [string, string]
	try {
		const bytes = Uint8Array.from(
			atob(signature.replace(/-/g, '+').replace(/_/g, '/') + '='),
			(char) => char.charCodeAt(0),
		)
		return (await crypto.subtle.verify(
			'HMAC',
			await signingKey(secret),
			bytes,
			new TextEncoder().encode(nonce),
		))
			? nonce
			: null
	} catch {
		return null
	}
}

export async function ensureBrowserBinding(
	request: Request,
	secret: string,
): Promise<{ browserBinding: string; cookie: string }> {
	const nonce = (await readBrowserNonce(request, secret)) ?? randomToken()
	const signature = base64url(
		new Uint8Array(
			await crypto.subtle.sign(
				'HMAC',
				await signingKey(secret),
				new TextEncoder().encode(nonce),
			),
		),
	)
	return {
		browserBinding: await sha256(nonce),
		cookie: `${COOKIE_NAME}=${nonce}.${signature}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`,
	}
}

export async function requireBrowserBinding(
	request: Request,
	secret: string,
): Promise<string> {
	const nonce = await readBrowserNonce(request, secret)
	if (!nonce)
		throw new AuthServiceError(
			400,
			'browser_session_missing',
			'This browser authorization session expired. Start again.',
		)
	return sha256(nonce)
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
