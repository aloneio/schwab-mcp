import { randomToken } from '../service'

export function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(char) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
				char
			]!,
	)
}

/** A real page ends the form submission before the user navigates to another origin. */
export function renderContinuePage(options: {
	url: string
	approved: boolean
	cookie?: string
}): Response {
	const title = options.approved ? 'Continue to Schwab' : 'Connection cancelled'
	const description = options.approved
		? 'Your approval was recorded. Continue to Schwab to sign in and finish connecting.'
		: 'No connection was created. Return to your MCP client to finish cancelling.'
	const label = options.approved
		? 'Continue to Schwab sign-in'
		: 'Return to your MCP client'
	return new Response(
		`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head><body><main><h1>${title}</h1><p>${description}</p>
<p><a id="continue" href="${escapeHtml(options.url)}" rel="noreferrer">${label}</a></p>
</main></body></html>`,
		{
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
				'Referrer-Policy': 'no-referrer',
				'X-Content-Type-Options': 'nosniff',
				'Content-Security-Policy':
					"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
				...(options.cookie ? { 'Set-Cookie': options.cookie } : {}),
			},
		},
	)
}

export function renderApprovalDialog(options: {
	clientName: string
	redirectUri: string
	transactionId: string
	cookie: string
}): Response {
	const nonce = randomToken()
	const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Schwab</title>
<style nonce="${nonce}">
body{font-family:system-ui,sans-serif;background:#eef3f8;color:#172b42;margin:0;min-height:100vh;display:grid;place-items:center}
main{background:white;max-width:32rem;margin:1.5rem;padding:2rem;border-radius:1rem;box-shadow:0 8px 40px #172b4212}
h1{font-size:1.7rem}p{line-height:1.6}small{overflow-wrap:anywhere;color:#4e6175}form{display:flex;gap:.75rem;margin-top:1.5rem}
button{padding:.8rem 1rem;border:1px solid #a6b8cb;border-radius:.4rem;font:inherit;cursor:pointer}button[value=approve]{background:#075da8;color:white;border-color:#075da8}
</style></head><body><main>
<h1>Connect to Schwab</h1>
<p><strong>${escapeHtml(options.clientName)}</strong> requests read-only access to your Schwab account through this MCP server.</p>
<p>The connection can read account information and market data. It cannot place, replace, or cancel orders, or change account settings.</p>
<p><small>Client callback: ${escapeHtml(options.redirectUri)}</small></p>
<p>Approve to continue to Schwab sign-in. You can cancel this request.</p>
<form method="post" action="/authorize">
<input type="hidden" name="transaction" value="${escapeHtml(options.transactionId)}">
<button type="submit" name="decision" value="approve">Approve and continue</button>
<button type="submit" name="decision" value="deny">Cancel</button>
</form></main></body></html>`
	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Set-Cookie': options.cookie,
			'Cache-Control': 'no-store',
			// no-referrer makes Chromium send Origin: null on this form POST.
			'Referrer-Policy': 'same-origin',
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
		},
	})
}
