import { marketData, trader, type TokenData } from '@sudowealth/schwab-api'
import { type z } from 'zod'
import { AuthServiceError } from '../auth/service'
import {
	calendarDateSchema,
	moversQuerySchema,
	priceHistoryQuerySchema,
} from '../tools/market/schemas'
import { type ReadOnlySchwabClient, type WireData } from '../tools/types'

const SCHWAB_ORIGIN = 'https://api.schwabapi.com'
const READ_PATHS = [
	/^\/trader\/v1\/accounts(?:\/accountNumbers)?$/,
	/^\/trader\/v1\/accounts\/[^/]+$/,
	/^\/trader\/v1\/accounts\/[^/]+\/orders(?:\/\d+)?$/,
	/^\/trader\/v1\/accounts\/[^/]+\/transactions(?:\/\d+)?$/,
	/^\/trader\/v1\/(?:orders|userPreference)$/,
	/^\/marketdata\/v1\/(?:quotes|chains|expirationchain|pricehistory|instruments|markets)$/,
	/^\/marketdata\/v1\/[^/]+\/quotes$/,
	/^\/marketdata\/v1\/(?:instruments|movers)\/[^/]+$/,
	/^\/marketdata\/v1\/markets\/(?:equity|option|bond|future|forex)$/,
]

export interface ReadTokenProvider {
	getAccessToken(): Promise<string | null>
	refreshIfNeeded(options?: {
		force?: boolean
		accessToken?: string
	}): Promise<TokenData>
	invalidateIfCurrent(accessToken: string): Promise<void>
}

export class SchwabReadError extends Error {
	readonly name = 'SchwabApiError'
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
		private readonly requestId?: string,
	) {
		super(message)
	}
	getRequestId() {
		return this.requestId
	}
}

/** This is an enforcement boundary, independent of tool descriptions and SDK metadata. */
export function assertReadOnlyRequest(request: Request): void {
	const url = new URL(request.url)
	if (
		request.method !== 'GET' ||
		request.body !== null ||
		url.origin !== SCHWAB_ORIGIN ||
		url.username ||
		url.password ||
		url.hash ||
		/%(?:2f|5c|25)/i.test(url.pathname) ||
		!READ_PATHS.some((pattern) => pattern.test(url.pathname))
	) {
		throw new SchwabReadError(
			'Only supported Schwab read requests are permitted.',
			403,
			'read_only_policy',
		)
	}
}

/** Never forward arbitrary headers or follow a redirect with brokerage credentials. */
export function createReadOnlyFetch(
	fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
) {
	return async (request: Request): Promise<Response> => {
		assertReadOnlyRequest(request)
		request.signal.throwIfAborted()
		const headers = new Headers({ Accept: 'application/json' })
		const authorization = request.headers.get('Authorization')
		if (authorization) headers.set('Authorization', authorization)
		const response = await fetchImpl(
			new Request(request.url, {
				method: 'GET',
				headers,
				redirect: 'manual',
				signal: request.signal,
			}),
		)
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel()
			throw new SchwabReadError(
				'Unexpected redirect from Schwab.',
				502,
				'upstream_redirect',
			)
		}
		return response
	}
}

interface ReadMetadata<R> {
	method: string
	path: string
	pathSchema?: z.ZodTypeAny
	querySchema?: z.ZodTypeAny
	responseSchema: z.ZodType<R, z.ZodTypeDef, any>
}

type ReadOptions = { pathParams?: unknown; queryParams?: unknown }
interface ReaderOptions {
	fetch?: typeof fetch
	timeoutMs?: number
	/** Cancels only this caller's reads, never a shared authentication refresh. */
	signal?: AbortSignal
}

function withDeadline<T>(
	operation: () => Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			reject(signal.reason)
		}
		if (signal.aborted) {
			abort()
			return
		}
		signal.addEventListener('abort', abort, { once: true })
		void Promise.resolve()
			.then(() => {
				// Cancellation can occur after scheduling but before this operation starts.
				signal.throwIfAborted()
				return operation()
			})
			.then(
				(value) => {
					signal.removeEventListener('abort', abort)
					resolve(value)
				},
				(error) => {
					signal.removeEventListener('abort', abort)
					reject(error)
				},
			)
	})
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason)
			return
		}
		const abort = () => {
			clearTimeout(timer)
			reject(signal.reason)
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', abort)
			resolve()
		}, ms)
		signal.addEventListener('abort', abort, { once: true })
	})
}

function retryAfterMs(value: string | null, now: number): number | undefined {
	if (!value) return undefined
	const text = value.trim()
	if (/^\d+$/.test(text)) return Number(text) * 1000
	// Do not let Date.parse interpret invalid numeric delays as calendar dates.
	if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*(?:,|\s)/i.test(text))
		return undefined
	const date = Date.parse(text)
	return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

function validEnvelope(path: string, data: unknown): boolean {
	const object = (value: unknown): value is Record<string, unknown> =>
		value !== null && typeof value === 'object' && !Array.isArray(value)
	const arrayPaths = new Set([
		'/trader/v1/accounts',
		'/trader/v1/accounts/accountNumbers',
		'/trader/v1/orders',
		'/trader/v1/accounts/{accountNumber}/orders',
		'/trader/v1/accounts/{accountNumber}/transactions',
	])
	if (arrayPaths.has(path)) {
		if (!Array.isArray(data) || !data.every(object)) return false
		if (path === '/trader/v1/accounts')
			return data.every((item) => object(item.securitiesAccount))
		if (path === '/trader/v1/accounts/accountNumbers')
			return data.every(
				(item) =>
					typeof item.accountNumber === 'string' &&
					typeof item.hashValue === 'string',
			)
		return true
	}
	if (!object(data)) return false
	if (path === '/trader/v1/accounts/{accountNumber}')
		return object(data.securitiesAccount)
	if (path === '/trader/v1/userPreference')
		return (
			data.accounts === undefined ||
			(Array.isArray(data.accounts) && data.accounts.every(object))
		)
	return true
}

/** Reuse SDK data schemas, but keep request construction, authentication and transport local. */
export function createReadOnlySchwabClient(
	auth: ReadTokenProvider,
	options: ReaderOptions = {},
): ReadOnlySchwabClient {
	const fetchRead = createReadOnlyFetch(options.fetch)
	const endpoint = <R>(meta: ReadMetadata<R>) => {
		if (meta.method !== 'GET')
			throw new Error('Cannot register a non-read Schwab endpoint')
		return async (input: ReadOptions = {}): Promise<WireData<R>> => {
			const pathParams = (meta.pathSchema?.parse(input.pathParams ?? {}) ??
				{}) as Record<string, unknown>
			const queryParams = (meta.querySchema?.parse(input.queryParams ?? {}) ??
				{}) as Record<string, unknown>
			const path = meta.path.replace(/\{(\w+)\}/g, (_match, key: string) => {
				const value = pathParams[key]
				if (value === undefined || value === null)
					throw new Error('Missing path parameter')
				return encodeURIComponent(String(value))
			})
			const url = new URL(path, SCHWAB_ORIGIN)
			for (const [key, value] of Object.entries(queryParams)) {
				if (value !== undefined && value !== null) {
					url.searchParams.set(
						key,
						Array.isArray(value)
							? value.join(',')
							: value instanceof Date
								? value.toISOString()
								: String(value),
					)
				}
			}
			assertReadOnlyRequest(new Request(url))
			const controller = new AbortController()
			const cancel = () => {
				controller.abort(
					new SchwabReadError(
						'Schwab read request was cancelled.',
						499,
						'request_cancelled',
					),
				)
			}
			if (options.signal?.aborted) cancel()
			else options.signal?.addEventListener('abort', cancel, { once: true })
			const timeoutMs = options.timeoutMs ?? 30_000
			const deadline = Date.now() + timeoutMs
			const timeout = setTimeout(
				() =>
					controller.abort(
						new SchwabReadError(
							'Schwab read request timed out.',
							504,
							'upstream_timeout',
						),
					),
				timeoutMs,
			)
			try {
				let accessToken = await withDeadline(
					() => auth.getAccessToken(),
					controller.signal,
				)
				if (!accessToken)
					throw new SchwabReadError(
						'Reconnect to Schwab to continue reading data.',
						401,
						'reauthentication_required',
					)
				let refreshed = false
				let retries = 0
				while (true) {
					const response = await withDeadline(
						() =>
							fetchRead(
								new Request(url, {
									headers: { Authorization: `Bearer ${accessToken}` },
									signal: controller.signal,
								}),
							),
						controller.signal,
					)
					if (response.status === 401 && !refreshed) {
						await withDeadline(async () => {
							await response.body?.cancel()
						}, controller.signal)
						refreshed = true
						const rejectedAccessToken: string = accessToken
						accessToken = (
							await withDeadline<TokenData>(
								() =>
									auth.refreshIfNeeded({
										force: true,
										accessToken: rejectedAccessToken,
									}),
								controller.signal,
							)
						).accessToken
						continue
					}
					if (
						(response.status === 429 || response.status >= 500) &&
						retries < 2
					) {
						const now = Date.now()
						const delay = Math.max(
							250 * 2 ** retries,
							retryAfterMs(response.headers.get('Retry-After'), now) ?? 0,
						)
						// If another attempt cannot fit, return this upstream error instead
						// of retrying earlier than the server allows or hiding it as a timeout.
						if (delay < deadline - now) {
							await withDeadline(async () => {
								await response.body?.cancel()
							}, controller.signal)
							retries++
							await waitForRetry(delay, controller.signal)
							continue
						}
					}
					const requestId =
						response.headers.get('schwab-client-correl-id') ??
						response.headers.get('x-request-id') ??
						undefined
					if (!response.ok) {
						if (response.status === 401) {
							const rejectedAccessToken: string = accessToken
							await withDeadline(
								() => auth.invalidateIfCurrent(rejectedAccessToken),
								controller.signal,
							)
						}
						await withDeadline(async () => {
							await response.body?.cancel()
						}, controller.signal)
						throw new SchwabReadError(
							response.status === 401
								? 'Reconnect to Schwab to continue reading data.'
								: `Schwab read request failed (${response.status}).`,
							response.status,
							response.status === 401
								? 'reauthentication_required'
								: 'upstream_error',
							requestId,
						)
					}
					let data: unknown
					try {
						data = await withDeadline(() => response.json(), controller.signal)
					} catch {
						controller.signal.throwIfAborted()
						throw new SchwabReadError(
							'Schwab returned invalid JSON.',
							502,
							'upstream_format',
							requestId,
						)
					}
					if (!validEnvelope(meta.path, data))
						throw new SchwabReadError(
							'Schwab returned an unexpected response format.',
							502,
							'upstream_format',
							requestId,
						)
					// SDK 2.1 response schemas reject legitimate optional fields and strip new ones.
					// Preserve the JSON wire data after checking the envelope consumed by tools.
					return data as WireData<R>
				}
			} catch (error) {
				if (error instanceof SchwabReadError) throw error
				if (controller.signal.aborted) throw controller.signal.reason
				if (error instanceof AuthServiceError)
					throw new SchwabReadError(
						error.message,
						error.status,
						error.code,
						error.requestId,
					)
				throw new SchwabReadError(
					'Schwab read request could not be completed.',
					503,
					'upstream_unavailable',
				)
			} finally {
				clearTimeout(timeout)
				options.signal?.removeEventListener('abort', cancel)
			}
		}
	}

	const getQuotes = endpoint(marketData.quotes.getQuotesMeta)
	const getQuote = endpoint(marketData.quotes.getQuoteBySymbolIdMeta)
	const getQuoteBySymbolId: ReadOnlySchwabClient['marketData']['quotes']['getQuoteBySymbolId'] =
		async (input = {}) => {
			const pathParams = marketData.quotes.GetQuoteBySymbolIdPathParams.parse(
				input.pathParams ?? {},
			)
			const queryParams = marketData.quotes.GetQuoteBySymbolIdQueryParams.parse(
				input.queryParams ?? {},
			)
			// Futures symbols contain a slash. Keep them in the fixed quotes query route
			// so they never require an exception to the transport's path guard.
			if (pathParams.symbol_id.includes('/')) {
				return getQuotes({
					queryParams: {
						symbols: [pathParams.symbol_id],
						fields: queryParams.fields,
					},
				})
			}
			return getQuote({ pathParams, queryParams })
		}

	return Object.freeze({
		trader: Object.freeze({
			accounts: Object.freeze({
				getAccounts: endpoint(trader.accounts.getAccountsMeta),
				getAccountNumbers: endpoint(trader.accounts.getAccountNumbersMeta),
				getAccountByNumber: endpoint(trader.accounts.getAccountByNumberMeta),
			}),
			orders: Object.freeze({
				getOrders: endpoint(trader.orders.getOrdersMeta),
				getOrdersByAccount: endpoint(trader.orders.getOrdersByAccountMeta),
				getOrderByOrderId: endpoint(trader.orders.getOrderByOrderIdMeta),
			}),
			transactions: Object.freeze({
				getTransactions: endpoint(trader.transactions.getTransactionsMeta),
				getTransactionById: endpoint(
					trader.transactions.getTransactionByIdMeta,
				),
			}),
			userPreference: Object.freeze({
				getUserPreference: endpoint(
					trader.userPreference.getUserPreferenceMeta,
				),
			}),
		}),
		marketData: Object.freeze({
			quotes: Object.freeze({
				getQuotes,
				getQuoteBySymbolId,
			}),
			instruments: Object.freeze({
				getInstruments: endpoint(marketData.instruments.getInstrumentsMeta),
				getInstrumentByCusip: endpoint(
					marketData.instruments.getInstrumentByCusipMeta,
				),
			}),
			marketHours: Object.freeze({
				getMarketHours: endpoint({
					...marketData.marketHours.getMarketHoursMeta,
					querySchema: marketData.marketHours.GetMarketHoursQueryParams.extend({
						date: calendarDateSchema.optional(),
					}),
				}),
				getMarketHoursByMarketId: endpoint({
					...marketData.marketHours.getMarketHoursByMarketIdMeta,
					querySchema:
						marketData.marketHours.GetMarketHoursByMarketIdQueryParams.extend({
							date: calendarDateSchema.optional(),
						}),
				}),
			}),
			movers: Object.freeze({
				getMovers: endpoint({
					...marketData.movers.getMoversMeta,
					querySchema: moversQuerySchema,
				}),
			}),
			options: Object.freeze({
				getOptionChain: endpoint(marketData.options.getOptionChainMeta),
				getOptionExpirationChain: endpoint(
					marketData.options.getOptionExpirationChainMeta,
				),
			}),
			priceHistory: Object.freeze({
				getPriceHistory: endpoint({
					...marketData.priceHistory.getPriceHistoryMeta,
					querySchema: priceHistoryQuerySchema,
				}),
			}),
		}),
	})
}
