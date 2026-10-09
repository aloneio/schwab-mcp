import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
	type AuthRequest,
	type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { SchwabHandler } from '../src/auth/handler'
import { SchwabAuthService, type AuthStorage } from '../src/auth/service'
import { type Env } from '../types/env'

class MemoryStorage implements AuthStorage {
	private values = new Map<string, unknown>()
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

async function waitFor(
	check: () => Promise<boolean> | boolean,
	label: string,
): Promise<void> {
	const deadline = Date.now() + 10_000
	while (!(await check())) {
		assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`)
		await delay(50)
	}
}

interface CdpMessage {
	id?: number
	result?: unknown
	error?: { message: string }
	method?: string
	params?: Record<string, unknown>
}

class BrowserPage {
	private sequence = 0
	private pending = new Map<
		number,
		{ resolve: (result: unknown) => void; reject: (error: Error) => void }
	>()
	readonly logs: string[] = []
	readonly fixtureDestinations: string[] = []
	readonly unexpectedRequests: string[] = []
	readonly eventErrors: unknown[] = []
	private constructor(
		private socket: WebSocket,
		private fixtureOrigin: string,
	) {
		socket.addEventListener('message', (event) => {
			const message = JSON.parse(String(event.data)) as CdpMessage
			if (message.id) {
				const pending = this.pending.get(message.id)
				this.pending.delete(message.id)
				if (message.error) pending?.reject(new Error(message.error.message))
				else pending?.resolve(message.result)
			} else {
				void this.event(message).catch((error) => this.eventErrors.push(error))
			}
		})
		socket.addEventListener('close', () => {
			for (const pending of this.pending.values())
				pending.reject(new Error('Test browser connection closed'))
			this.pending.clear()
		})
	}
	static async connect(
		url: string,
		fixtureOrigin: string,
	): Promise<BrowserPage> {
		const socket = new WebSocket(url)
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener('open', () => resolve(), { once: true })
			socket.addEventListener(
				'error',
				() => reject(new Error('Unable to connect to isolated test browser')),
				{ once: true },
			)
		})
		const page = new BrowserPage(socket, fixtureOrigin)
		await page.command('Page.enable')
		await page.command('Log.enable')
		// No page request can reach Schwab or another public origin. Only this
		// loopback app is continued; both external destinations are fulfilled here.
		await page.command('Fetch.enable', {
			patterns: [{ urlPattern: '*', requestStage: 'Request' }],
		})
		return page
	}
	private async event(message: CdpMessage): Promise<void> {
		if (message.method === 'Log.entryAdded') {
			const entry = message.params?.entry as { text: string }
			this.logs.push(entry.text)
		}
		if (message.method !== 'Fetch.requestPaused') return
		const { requestId, request } = message.params as {
			requestId: string
			request: { url: string; method: string }
		}
		const url = new URL(request.url)
		if (url.origin === this.fixtureOrigin) {
			await this.command('Fetch.continueRequest', { requestId })
			return
		}
		if (
			url.pathname === '/favicon.ico' &&
			['https://api.schwabapi.com', 'https://client.fixture.example'].includes(
				url.origin,
			)
		) {
			await this.command('Fetch.fulfillRequest', {
				requestId,
				responseCode: 204,
			})
			return
		}
		if (
			(url.origin === 'https://api.schwabapi.com' &&
				url.pathname === '/v1/oauth/authorize') ||
			(url.origin === 'https://client.fixture.example' &&
				url.pathname === '/callback')
		) {
			assert.equal(request.method, 'GET')
			this.fixtureDestinations.push(request.url)
			await this.command('Fetch.fulfillRequest', {
				requestId,
				responseCode: 200,
				responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
				body: Buffer.from(
					'<html><body>Local authorization destination fixture</body></html>',
				).toString('base64'),
			})
			return
		}
		this.unexpectedRequests.push(request.url)
		await this.command('Fetch.failRequest', {
			requestId,
			errorReason: 'BlockedByClient',
		})
	}
	command<T = unknown>(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const id = ++this.sequence
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`Browser command timed out: ${method}`))
			}, 10_000)
			this.pending.set(id, {
				resolve: (result) => {
					clearTimeout(timer)
					resolve(result as T)
				},
				reject: (error) => {
					clearTimeout(timer)
					reject(error)
				},
			})
			this.socket.send(JSON.stringify({ id, method, params }))
		})
	}
	async evaluate<T>(expression: string): Promise<T> {
		const result = await this.command<{
			result: { value: T }
			exceptionDetails?: unknown
		}>('Runtime.evaluate', { expression, returnByValue: true })
		assert.equal(result.exceptionDetails, undefined)
		return result.result.value
	}
	close(): void {
		this.socket.close()
	}
}

await test(
	'real browser approval and cancellation finish on-origin before following safe external links',
	{ timeout: 90_000 },
	async () => {
		const executable = [
			process.env.BROWSER_EXECUTABLE,
			'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
			'C:/Program Files/Google/Chrome/Application/chrome.exe',
			'/usr/bin/google-chrome',
			'/usr/bin/chromium',
			'/usr/bin/chromium-browser',
		].find((path): path is string => !!path && existsSync(path))
		assert.ok(
			executable,
			'Set BROWSER_EXECUTABLE to an installed Chromium, Chrome or Edge binary',
		)
		const scratchRoot = resolve('.wrangler')
		await mkdir(scratchRoot, { recursive: true })
		const profile = await mkdtemp(join(scratchRoot, 'browser-auth-'))
		const credentials = {
			SCHWAB_CLIENT_ID: 'fixture-client',
			SCHWAB_CLIENT_SECRET: 'fixture-secret',
			SCHWAB_REDIRECT_URI: 'https://server.fixture.example/callback',
		}
		const objects = new Map<string, SchwabAuthService>()
		const noNetwork: typeof fetch = async () => {
			throw new Error('Auth fixture must not contact live services')
		}
		const request: AuthRequest = {
			responseType: 'code',
			clientId: 'fixture-client',
			redirectUri: 'https://client.fixture.example/callback',
			scope: ['read'],
			state: 'fixture-client-state',
			codeChallenge: 'a'.repeat(43),
			codeChallengeMethod: 'S256',
		}
		const env = {
			...credentials,
			COOKIE_ENCRYPTION_KEY: 'fixture-signing-key-at-least-32-bytes',
			OAUTH_KV: {},
			SCHWAB_AUTH: {
				idFromName: (name: string) => name,
				get(id: string) {
					if (!objects.has(id))
						objects.set(
							id,
							new SchwabAuthService(
								new MemoryStorage(),
								credentials,
								noNetwork,
							),
						)
					return {
						fetch: (url: string, init: RequestInit) =>
							objects.get(id)!.fetch(new Request(url, init)),
					}
				},
			},
			OAUTH_PROVIDER: {
				parseAuthRequest: async () => request,
				lookupClient: async () => ({
					clientId: request.clientId,
					clientName: 'Browser fixture',
					redirectUris: [request.redirectUri],
				}),
			},
		} as unknown as Env & { OAUTH_PROVIDER: OAuthHelpers }
		let origin = ''
		const serverErrors: unknown[] = []
		const responses: Array<{
			method: string | undefined
			status: number
			cookie: boolean
			origin: string | null
		}> = []
		const serve = async (
			incoming: IncomingMessage,
			outgoing: ServerResponse,
		) => {
			const chunks: Buffer[] = []
			for await (const chunk of incoming)
				chunks.push(Buffer.from(chunk as Buffer))
			const headers = new Headers()
			for (const [key, value] of Object.entries(incoming.headers)) {
				if (typeof value === 'string') headers.set(key, value)
			}
			const response = await SchwabHandler.fetch(
				new Request(new URL(incoming.url!, origin), {
					method: incoming.method,
					headers,
					...(chunks.length
						? { body: new Uint8Array(Buffer.concat(chunks)) }
						: {}),
				}),
				env,
			)
			responses.push({
				method: incoming.method,
				status: response.status,
				cookie: headers.has('Cookie'),
				origin: headers.get('Origin'),
			})
			outgoing.writeHead(response.status, Object.fromEntries(response.headers))
			outgoing.end(await response.text())
		}
		const server = createServer((incoming, outgoing) => {
			void serve(incoming, outgoing).catch((error) => {
				serverErrors.push(error)
				outgoing.writeHead(500).end('Fixture failed')
			})
		})
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		const address = server.address()
		assert.ok(address && typeof address !== 'string')
		// Chromium accepts Secure/__Host cookies on localhost, keeping the real app's attributes intact.
		origin = `http://localhost:${address.port}`
		const browser = spawn(
			executable,
			[
				'--headless=new',
				'--disable-gpu',
				'--no-first-run',
				'--no-default-browser-check',
				'--disable-background-networking',
				'--disable-extensions',
				'--remote-debugging-port=0',
				`--user-data-dir=${profile}`,
				'about:blank',
			],
			{ windowsHide: true },
		)
		let diagnostics = ''
		let launchError: Error | undefined
		browser.stderr.on('data', (chunk) => {
			diagnostics += String(chunk)
		})
		browser.once('error', (error) => {
			launchError = error
		})
		let page: BrowserPage | undefined
		try {
			await waitFor(() => {
				if (launchError) throw launchError
				return /DevTools listening on (ws:\/\/[^\s]+)/.test(diagnostics)
			}, 'browser startup')
			const browserSocket = /DevTools listening on (ws:\/\/[^\s]+)/.exec(
				diagnostics,
			)![1]!
			const tabs = (await (
				await fetch(`http://${new URL(browserSocket).host}/json/list`)
			).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>
			const tab = tabs.find((tab) => tab.type === 'page')
			assert.ok(tab)
			page = await BrowserPage.connect(tab.webSocketDebuggerUrl, origin)
			for (const decision of ['approve', 'deny']) {
				await page.command('Page.navigate', { url: `${origin}/authorize` })
				await waitFor(
					() =>
						page!.evaluate<boolean>(
							'!!document.querySelector("button[value=approve]")',
						),
					'consent form',
				)
				await page.evaluate(
					`document.querySelector('button[value="${decision}"]').click()`,
				)
				await waitFor(
					() =>
						page!.evaluate<boolean>('!!document.querySelector("a#continue")'),
					'same-origin continuation page',
				)
				assert.equal(await page.evaluate('location.origin'), origin)
				assert.equal(
					page.fixtureDestinations.length,
					decision === 'approve' ? 0 : 1,
					'External navigation requires the Continue click',
				)
				const link: URL = new URL(
					await page.evaluate<string>(
						'document.querySelector("a#continue").href',
					),
				)
				if (decision === 'approve')
					assert.equal(link.origin, 'https://api.schwabapi.com')
				else assert.equal(link.searchParams.get('error'), 'access_denied')
				await page.evaluate('document.querySelector("a#continue").click()')
				await waitFor(
					() =>
						page!.fixtureDestinations.some(
							(destination) => destination === link.href,
						),
					'external destination fixture',
				)
				await waitFor(
					() =>
						page!.evaluate<boolean>(
							'document.body.textContent.includes("Local authorization destination fixture")',
						),
					'destination document',
				)
			}
			assert.equal(page.fixtureDestinations.length, 2)
			assert.deepEqual(page.eventErrors, [])
			assert.deepEqual(page.unexpectedRequests, [])
			assert.deepEqual(serverErrors, [])
			assert.equal(
				page.logs.some((line) => line.includes('form-action')),
				false,
				page.logs.join('\n'),
			)
		} catch (error) {
			throw new Error(
				`${String(error)}; browser=${await page?.evaluate('document.body?.textContent')}; responses=${JSON.stringify(responses)}; log=${JSON.stringify(page?.logs)}`,
				{ cause: error },
			)
		} finally {
			await page?.command('Browser.close').catch(() => {})
			page?.close()
			if (browser.exitCode === null) browser.kill()
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
			assert.ok(profile.startsWith(`${scratchRoot}${sep}`))
			await rm(profile, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			})
		}
	},
)
