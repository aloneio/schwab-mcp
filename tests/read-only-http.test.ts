import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { AuthServiceError } from '../src/auth/service'
import {
	createReadOnlyFetch,
	createReadOnlySchwabClient,
	SchwabReadError,
	type ReadTokenProvider,
} from '../src/shared/schwabReadClient'
import { type ReadOnlySchwabClient } from '../src/tools/types'

const origin = 'https://api.schwabapi.com'
const auth: ReadTokenProvider = {
	getAccessToken: async () => 'fixture-access-token',
	refreshIfNeeded: async () => {
		throw new Error('Unexpected fixture refresh')
	},
	invalidateIfCurrent: async () => {
		throw new Error('Unexpected fixture invalidation')
	},
}
const account = {
	accountNumber: '11112222',
	hashValue: 'fixture-account',
	addedByUpstream: { retained: true },
}
const accountDetails = {
	securitiesAccount: {
		accountNumber: '11112222',
		type: 'CASH',
		addedByUpstream: true,
	},
}
const order = {
	orderId: 7,
	accountNumber: 11112222,
	enteredTime: '2026-10-01T10:00:00+00:00',
	addedByUpstream: { retained: true },
}
const transaction = {
	activityId: 9,
	accountNumber: '11112222',
	time: '2026-10-01T10:00:00-04:00',
	addedByUpstream: true,
}
const quotes = {
	DEMO: { symbol: 'DEMO', quote: { lastPrice: 42 }, addedByUpstream: true },
}
const instruments = {
	instruments: [
		{
			symbol: 'DEMO',
			assetType: 'EQUITY',
			fundamental: { peRatio: 10 },
			addedByUpstream: true,
		},
	],
}
const hours = {
	equity: { EQ: { date: '2026-10-09', isOpen: true, addedByUpstream: true } },
}
const orderQuery = {
	fromEnteredTime: '2026-09-01T00:00:00.000Z',
	toEnteredTime: '2026-10-01T00:00:00.000Z',
	maxResults: 10,
	status: 'FILLED' as const,
}
const transactionQuery = {
	startDate: '2026-09-01T00:00:00.000Z',
	endDate: '2026-10-01T00:00:00.000Z',
	types: 'TRADE' as const,
	symbol: 'DEMO',
}

type EndpointCase = {
	name: string
	call: (client: ReadOnlySchwabClient) => Promise<unknown>
	path: string
	query: Record<string, string>
	response: unknown
}

const cases: EndpointCase[] = [
	{
		name: 'trader.accounts.getAccounts',
		call: (c) =>
			c.trader.accounts.getAccounts({ queryParams: { fields: 'positions' } }),
		path: '/trader/v1/accounts',
		query: { fields: 'positions' },
		response: [accountDetails],
	},
	{
		name: 'trader.accounts.getAccountNumbers',
		call: (c) => c.trader.accounts.getAccountNumbers(),
		path: '/trader/v1/accounts/accountNumbers',
		query: {},
		response: [account],
	},
	{
		name: 'trader.accounts.getAccountByNumber',
		call: (c) =>
			c.trader.accounts.getAccountByNumber({
				pathParams: { accountNumber: 'fixture-account' },
				queryParams: { fields: 'positions' },
			}),
		path: '/trader/v1/accounts/fixture-account',
		query: { fields: 'positions' },
		response: accountDetails,
	},
	{
		name: 'trader.orders.getOrders',
		call: (c) => c.trader.orders.getOrders({ queryParams: orderQuery }),
		path: '/trader/v1/orders',
		query: { ...orderQuery, maxResults: '10' },
		response: [order],
	},
	{
		name: 'trader.orders.getOrdersByAccount',
		call: (c) =>
			c.trader.orders.getOrdersByAccount({
				pathParams: { accountNumber: 'fixture-account' },
				queryParams: orderQuery,
			}),
		path: '/trader/v1/accounts/fixture-account/orders',
		query: { ...orderQuery, maxResults: '10' },
		response: [order],
	},
	{
		name: 'trader.orders.getOrderByOrderId',
		call: (c) =>
			c.trader.orders.getOrderByOrderId({
				pathParams: { accountNumber: 'fixture-account', orderId: 7 },
			}),
		path: '/trader/v1/accounts/fixture-account/orders/7',
		query: {},
		response: order,
	},
	{
		name: 'trader.transactions.getTransactions',
		call: (c) =>
			c.trader.transactions.getTransactions({
				pathParams: { accountNumber: 'fixture-account' },
				queryParams: transactionQuery,
			}),
		path: '/trader/v1/accounts/fixture-account/transactions',
		query: transactionQuery,
		response: [transaction],
	},
	{
		name: 'trader.transactions.getTransactionById',
		call: (c) =>
			c.trader.transactions.getTransactionById({
				pathParams: { accountNumber: 'fixture-account', transactionId: 9 },
			}),
		path: '/trader/v1/accounts/fixture-account/transactions/9',
		query: {},
		response: transaction,
	},
	{
		name: 'trader.userPreference.getUserPreference',
		call: (c) => c.trader.userPreference.getUserPreference(),
		path: '/trader/v1/userPreference',
		query: {},
		response: { accounts: [], streamerInfo: [], addedByUpstream: true },
	},
	{
		name: 'marketData.quotes.getQuotes',
		call: (c) =>
			c.marketData.quotes.getQuotes({
				queryParams: {
					symbols: ['DEMO', 'SAMPLE'],
					fields: ['quote', 'reference'],
					indicative: false,
				},
			}),
		path: '/marketdata/v1/quotes',
		query: {
			symbols: 'DEMO,SAMPLE',
			fields: 'quote,reference',
			indicative: 'false',
		},
		response: quotes,
	},
	{
		name: 'marketData.quotes.getQuoteBySymbolId',
		call: (c) =>
			c.marketData.quotes.getQuoteBySymbolId({
				pathParams: { symbol_id: 'DEMO  261009C00100000' },
				queryParams: { fields: ['quote', 'reference'] },
			}),
		path: '/marketdata/v1/DEMO%20%20261009C00100000/quotes',
		query: { fields: 'quote,reference' },
		response: quotes,
	},
	{
		name: 'marketData.instruments.getInstruments',
		call: (c) =>
			c.marketData.instruments.getInstruments({
				queryParams: { symbol: 'DEMO', projection: 'fundamental' },
			}),
		path: '/marketdata/v1/instruments',
		query: { symbol: 'DEMO', projection: 'fundamental' },
		response: instruments,
	},
	{
		name: 'marketData.instruments.getInstrumentByCusip',
		call: (c) =>
			c.marketData.instruments.getInstrumentByCusip({
				pathParams: { cusip_id: '000000000' },
			}),
		path: '/marketdata/v1/instruments/000000000',
		query: {},
		response: instruments,
	},
	{
		name: 'marketData.marketHours.getMarketHours',
		call: (c) =>
			c.marketData.marketHours.getMarketHours({
				queryParams: { markets: ['equity', 'option'], date: '2026-10-09' },
			}),
		path: '/marketdata/v1/markets',
		query: { markets: 'equity,option', date: '2026-10-09' },
		response: hours,
	},
	{
		name: 'marketData.marketHours.getMarketHoursByMarketId',
		call: (c) =>
			c.marketData.marketHours.getMarketHoursByMarketId({
				pathParams: { market_id: 'equity' },
				queryParams: { date: '2026-10-09' },
			}),
		path: '/marketdata/v1/markets/equity',
		query: { date: '2026-10-09' },
		response: hours,
	},
	{
		name: 'marketData.movers.getMovers',
		call: (c) =>
			c.marketData.movers.getMovers({
				pathParams: { symbol_id: '$SPX' },
				queryParams: { sort: 'PERCENT_CHANGE_DOWN', frequency: 0 },
			}),
		path: '/marketdata/v1/movers/%24SPX',
		query: { sort: 'PERCENT_CHANGE_DOWN', frequency: '0' },
		response: { screeners: [{ symbol: 'DEMO', addedByUpstream: true }] },
	},
	{
		name: 'marketData.options.getOptionChain',
		call: (c) =>
			c.marketData.options.getOptionChain({
				queryParams: {
					symbol: 'DEMO',
					contractType: 'CALL',
					strikeCount: 5,
					fromDate: '2026-10-09',
					toDate: '2026-11-09',
					strategy: 'ANALYTICAL',
					strike: 100,
					range: 'OTM',
					includeUnderlyingQuote: false,
				},
			}),
		path: '/marketdata/v1/chains',
		query: {
			symbol: 'DEMO',
			contractType: 'CALL',
			strikeCount: '5',
			fromDate: '2026-10-09',
			toDate: '2026-11-09',
			strategy: 'ANALYTICAL',
			strike: '100',
			range: 'OTM',
			includeUnderlyingQuote: 'false',
		},
		response: { symbol: 'DEMO', callExpDateMap: {}, addedByUpstream: true },
	},
	{
		name: 'marketData.options.getOptionExpirationChain',
		call: (c) =>
			c.marketData.options.getOptionExpirationChain({
				queryParams: { symbol: 'DEMO' },
			}),
		path: '/marketdata/v1/expirationchain',
		query: { symbol: 'DEMO' },
		response: { expirationList: [], addedByUpstream: true },
	},
	{
		name: 'marketData.priceHistory.getPriceHistory',
		call: (c) =>
			c.marketData.priceHistory.getPriceHistory({
				queryParams: {
					symbol: 'DEMO',
					periodType: 'day',
					period: 5,
					frequencyType: 'minute',
					frequency: 5,
					startDate: Date.parse('2026-09-01'),
					endDate: Date.parse('2026-10-01'),
					needExtendedHoursData: false,
					needPreviousClose: true,
				},
			}),
		path: '/marketdata/v1/pricehistory',
		query: {
			symbol: 'DEMO',
			periodType: 'day',
			period: '5',
			frequencyType: 'minute',
			frequency: '5',
			startDate: String(Date.parse('2026-09-01')),
			endDate: String(Date.parse('2026-10-01')),
			needExtendedHoursData: 'false',
			needPreviousClose: 'true',
		},
		response: {
			symbol: 'DEMO',
			candles: [{ datetime: 1791510000000, close: 42, addedByUpstream: true }],
			previousClose: 41,
		},
	},
]

void test('all 19 adapter methods use exact GET routes and preserve raw partial upstream responses', async (t) => {
	assert.equal(cases.length, 19)
	assert.equal(new Set(cases.map((item) => item.name)).size, 19)
	for (const item of cases) {
		await t.test(item.name, async () => {
			const requests: Request[] = []
			const client = createReadOnlySchwabClient(auth, {
				fetch: async (input, init) => {
					requests.push(new Request(input, init))
					return Response.json(item.response)
				},
			})
			assert.deepEqual(await item.call(client), item.response)
			assert.equal(requests.length, 1)
			const request = requests[0]!
			const url = new URL(request.url)
			assert.equal(request.method, 'GET')
			assert.equal(request.body, null)
			assert.equal(request.redirect, 'manual')
			assert.equal(url.origin, origin)
			assert.equal(url.pathname, item.path)
			assert.deepEqual(Object.fromEntries(url.searchParams), item.query)
			assert.equal([...url.searchParams].length, Object.keys(item.query).length)
			assert.equal(
				request.headers.get('Authorization'),
				'Bearer fixture-access-token',
			)
			assert.equal(request.headers.get('Accept'), 'application/json')
		})
	}
})

void test('single-symbol futures quotes use the fixed bulk route and preserve fields and response records', async () => {
	const requests: Request[] = []
	const response = {
		'/ES': {
			assetType: 'FUTURE',
			quote: { lastPrice: 5500.25 },
			addedByUpstream: true,
		},
	}
	const client = createReadOnlySchwabClient(auth, {
		fetch: async (input, init) => {
			requests.push(new Request(input, init))
			return Response.json(response)
		},
	})
	assert.deepEqual(
		await client.marketData.quotes.getQuoteBySymbolId({
			pathParams: { symbol_id: '/ES' },
			queryParams: { fields: ['quote', 'reference'] },
		}),
		response,
	)
	assert.equal(requests.length, 1)
	const request = requests[0]!
	const url = new URL(request.url)
	assert.equal(request.method, 'GET')
	assert.equal(request.redirect, 'manual')
	assert.equal(url.origin, origin)
	assert.equal(url.pathname, '/marketdata/v1/quotes')
	assert.deepEqual(Object.fromEntries(url.searchParams), {
		symbols: '/ES',
		fields: 'quote,reference',
	})
	await assert.rejects(
		client.marketData.quotes.getQuoteBySymbolId({
			pathParams: { symbol_id: '/ES' },
			queryParams: { fields: ['unsupported'] as never },
		}),
	)
	assert.equal(requests.length, 1, 'Invalid fields must fail before transport')
})

void test('runtime client exposes exactly the frozen 19 GET methods without SDK internals or writes', () => {
	const client = createReadOnlySchwabClient(auth, {
		fetch: async () => {
			throw new Error('No request expected')
		},
	})
	function functionPaths(value: unknown, prefix = ''): string[] {
		if (typeof value === 'function') return [prefix]
		assert.ok(value && typeof value === 'object')
		assert.equal(Object.isFrozen(value), true, prefix)
		return Object.entries(value).flatMap(([key, child]) =>
			functionPaths(child, prefix ? `${prefix}.${key}` : key),
		)
	}
	assert.deepEqual(
		functionPaths(client).sort(),
		cases.map((item) => item.name).sort(),
	)
	for (const key of [
		'createEndpoint',
		'_context',
		'all',
		'auth',
		'schemas',
		'debugAuth',
	])
		assert.equal(key in client, false, key)
	for (const key of [
		'placeOrder',
		'placeOrderForAccount',
		'replaceOrder',
		'cancelOrder',
	])
		assert.equal(key in client.trader.orders, false, key)
})

void test('read-only fetch rejects ordinary disallowed operations before the injected transport', async () => {
	let fetchCalls = 0
	const fetchRead = createReadOnlyFetch(async () => {
		fetchCalls++
		return Response.json({})
	})
	for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
		await assert.rejects(
			fetchRead(
				new Request(`${origin}/trader/v1/accounts/fixture-account/orders`, {
					method,
				}),
			),
			(error: unknown) =>
				error instanceof SchwabReadError && error.code === 'read_only_policy',
		)
	}
	for (const url of [
		`${origin}/marketdata/v1/not-supported`,
		'https://example.test/marketdata/v1/quotes',
	]) {
		await assert.rejects(
			fetchRead(new Request(url)),
			(error: unknown) =>
				error instanceof SchwabReadError && error.code === 'read_only_policy',
		)
	}
	assert.equal(fetchCalls, 0)
})

void test('read-only fetch keeps only approved headers and refuses upstream redirects', async () => {
	let captured: Request | undefined
	const fetchRead = createReadOnlyFetch(async (input, init) => {
		captured = new Request(input, init)
		return new Response(null, {
			status: 302,
			headers: { Location: 'https://example.test/' },
		})
	})
	await assert.rejects(
		fetchRead(
			new Request(`${origin}/marketdata/v1/quotes`, {
				headers: {
					Authorization: 'Bearer fixture-token',
					Cookie: 'fixture-cookie',
					'X-Fixture': 'omit',
				},
			}),
		),
		(error: unknown) =>
			error instanceof SchwabReadError && error.code === 'upstream_redirect',
	)
	assert.ok(captured)
	assert.equal(captured.redirect, 'manual')
	assert.deepEqual(
		[...captured.headers],
		[
			['accept', 'application/json'],
			['authorization', 'Bearer fixture-token'],
		],
	)
})

void test('401 retries once with refreshed credentials and identifies the rejected access token', async () => {
	const refreshOptions: unknown[] = []
	const authorization: Array<string | null> = []
	const invalidated: string[] = []
	const client = createReadOnlySchwabClient(
		{
			getAccessToken: async () => 'fixture-old-token',
			refreshIfNeeded: async (options) => {
				refreshOptions.push(options)
				return { accessToken: 'fixture-new-token' }
			},
			invalidateIfCurrent: async (token) => {
				invalidated.push(token)
			},
		},
		{
			fetch: async (input, init) => {
				authorization.push(
					new Request(input, init).headers.get('Authorization'),
				)
				return authorization.length === 1
					? Response.json({}, { status: 401 })
					: Response.json(quotes)
			},
		},
	)
	assert.deepEqual(
		await client.marketData.quotes.getQuotes({
			queryParams: { symbols: ['DEMO'] },
		}),
		quotes,
	)
	assert.deepEqual(refreshOptions, [
		{ force: true, accessToken: 'fixture-old-token' },
	])
	assert.deepEqual(authorization, [
		'Bearer fixture-old-token',
		'Bearer fixture-new-token',
	])
	assert.deepEqual(invalidated, [])
})

void test('a second 401 stops without repeated refresh or upstream error-body disclosure', async () => {
	let refreshes = 0
	let requests = 0
	const invalidated: string[] = []
	const client = createReadOnlySchwabClient(
		{
			getAccessToken: async () => 'fixture-old-token',
			refreshIfNeeded: async () => {
				refreshes++
				return { accessToken: 'fixture-new-token' }
			},
			invalidateIfCurrent: async (token) => {
				invalidated.push(token)
			},
		},
		{
			fetch: async () => {
				requests++
				return Response.json(
					{ message: 'fixture-private-upstream-detail' },
					{ status: 401, headers: { 'x-request-id': 'fixture-request-id' } },
				)
			},
		},
	)
	await assert.rejects(
		client.marketData.quotes.getQuotes({ queryParams: { symbols: ['DEMO'] } }),
		(error: unknown) => {
			assert.ok(error instanceof SchwabReadError)
			assert.equal(error.status, 401)
			assert.equal(error.code, 'reauthentication_required')
			assert.equal(error.getRequestId(), 'fixture-request-id')
			assert.ok(!error.message.includes('fixture-private-upstream-detail'))
			return true
		},
	)
	assert.equal(requests, 2)
	assert.equal(refreshes, 1)
	assert.deepEqual(invalidated, ['fixture-new-token'])
})

void test('missing credentials produce no upstream request', async () => {
	let requests = 0
	const client = createReadOnlySchwabClient(
		{ ...auth, getAccessToken: async () => null },
		{
			fetch: async () => {
				requests++
				return Response.json({})
			},
		},
	)
	await assert.rejects(
		client.trader.accounts.getAccountNumbers(),
		(error: unknown) =>
			error instanceof SchwabReadError && error.status === 401,
	)
	assert.equal(requests, 0)
})

void test('the reader validates envelopes needed by account processing while preserving optional fields', async (t) => {
	for (const [name, response, call] of [
		[
			'accounts require an array',
			{},
			(c: ReadOnlySchwabClient) => c.trader.accounts.getAccounts(),
		],
		[
			'accounts require securitiesAccount objects',
			[{}],
			(c: ReadOnlySchwabClient) => c.trader.accounts.getAccounts(),
		],
		[
			'account selectors require both string IDs',
			[{ accountNumber: '11112222' }],
			(c: ReadOnlySchwabClient) => c.trader.accounts.getAccountNumbers(),
		],
		[
			'user preference accounts must be an array',
			{ accounts: {} },
			(c: ReadOnlySchwabClient) => c.trader.userPreference.getUserPreference(),
		],
		[
			'quotes require an object',
			[],
			(c: ReadOnlySchwabClient) =>
				c.marketData.quotes.getQuotes({ queryParams: { symbols: ['DEMO'] } }),
		],
	] as const) {
		await t.test(name, async () => {
			const client = createReadOnlySchwabClient(auth, {
				fetch: async () => Response.json(response),
			})
			await assert.rejects(
				call(client),
				(error: unknown) =>
					error instanceof SchwabReadError && error.code === 'upstream_format',
			)
		})
	}
})

function observe(promise: Promise<unknown>) {
	const result: { settled: boolean; error?: unknown } = { settled: false }
	void promise.then(
		() => {
			result.settled = true
		},
		(error) => {
			result.settled = true
			result.error = error
		},
	)
	return result
}

function assertTimedOut(result: ReturnType<typeof observe>) {
	assert.equal(
		result.settled,
		true,
		'The public request must settle at its deadline',
	)
	assert.ok(result.error instanceof SchwabReadError)
	assert.equal(result.error.status, 504)
	assert.equal(result.error.code, 'upstream_timeout')
}

void test('one request deadline bounds stalled authentication, fetch, body, and cancellation operations', async (t) => {
	for (const stage of [
		'token',
		'refresh',
		'invalidate',
		'fetch',
		'body',
		'cancel',
	] as const) {
		await t.test(stage, async (t) => {
			t.mock.timers.enable({ apis: ['setTimeout'] })
			const pending = new Promise<never>(() => {})
			let requests = 0
			let refreshes = 0
			let requestSignal: AbortSignal | undefined
			const client = createReadOnlySchwabClient(
				{
					getAccessToken: () =>
						stage === 'token'
							? pending
							: Promise.resolve('fixture-access-token'),
					refreshIfNeeded: () => {
						refreshes++
						return stage === 'invalidate'
							? Promise.resolve({ accessToken: 'fixture-new-token' })
							: pending
					},
					invalidateIfCurrent: () =>
						stage === 'invalidate' ? pending : Promise.resolve(),
				},
				{
					timeoutMs: 20,
					fetch: (input, init) => {
						requests++
						requestSignal = new Request(input, init).signal
						if (stage === 'fetch') return pending
						if (stage === 'refresh' || stage === 'invalidate')
							return Promise.resolve(Response.json({}, { status: 401 }))
						if (stage === 'cancel')
							return Promise.resolve(
								new Response(new ReadableStream({ cancel: () => pending }), {
									status: 401,
								}),
							)
						const response = Response.json(quotes)
						if (stage === 'body') response.json = () => pending
						return Promise.resolve(response)
					},
				},
			)
			const result = observe(
				client.marketData.quotes.getQuotes({
					queryParams: { symbols: ['DEMO'] },
				}),
			)
			await setImmediate()
			assert.equal(result.settled, false)
			t.mock.timers.tick(20)
			await setImmediate()
			assertTimedOut(result)
			assert.equal(
				requests,
				stage === 'token' ? 0 : stage === 'invalidate' ? 2 : 1,
			)
			assert.equal(
				refreshes,
				stage === 'refresh' || stage === 'invalidate' ? 1 : 0,
			)
			if (requestSignal) assert.equal(requestSignal.aborted, true)
		})
	}
})

void test('deadline aborts a pending backoff without waiting for or issuing the retry', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	let requests = 0
	const client = createReadOnlySchwabClient(auth, {
		timeoutMs: 20,
		fetch: async () => {
			requests++
			return Response.json({}, { status: 503, headers: { 'Retry-After': '1' } })
		},
	})
	const result = observe(
		client.marketData.quotes.getQuotes({ queryParams: { symbols: ['DEMO'] } }),
	)
	await setImmediate()
	assert.equal(requests, 1)
	assert.equal(result.settled, false)
	t.mock.timers.tick(20)
	await setImmediate()
	assertTimedOut(result)
	t.mock.timers.tick(2000)
	await setImmediate()
	assert.equal(requests, 1)
})

void test('safe authentication-service errors preserve status, code, message, and request ID', async (t) => {
	for (const stage of ['token', 'refresh'] as const) {
		await t.test(stage, async () => {
			const expected = new AuthServiceError(
				429,
				'refresh_rate_limited',
				'Authentication is temporarily rate limited.',
				'fixture-auth-request-id',
			)
			let requests = 0
			const client = createReadOnlySchwabClient(
				{
					getAccessToken: async () => {
						if (stage === 'token') throw expected
						return 'fixture-access-token'
					},
					refreshIfNeeded: async () => {
						throw expected
					},
					invalidateIfCurrent: auth.invalidateIfCurrent,
				},
				{
					fetch: async () => {
						requests++
						return Response.json({}, { status: 401 })
					},
				},
			)
			await assert.rejects(
				client.trader.accounts.getAccountNumbers(),
				(error: unknown) => {
					assert.ok(error instanceof SchwabReadError)
					assert.equal(error.status, expected.status)
					assert.equal(error.code, expected.code)
					assert.equal(error.message, expected.message)
					assert.equal(error.getRequestId(), expected.requestId)
					return true
				},
			)
			assert.equal(requests, stage === 'token' ? 0 : 1)
		})
	}
})

void test('unknown authentication errors expose a generic failure without private details', async () => {
	const client = createReadOnlySchwabClient(
		{
			...auth,
			getAccessToken: async () => {
				throw new Error('fixture-private-auth-context')
			},
		},
		{
			fetch: async () => {
				throw new Error('No fetch should run')
			},
		},
	)
	await assert.rejects(
		client.trader.accounts.getAccountNumbers(),
		(error: unknown) => {
			assert.ok(error instanceof SchwabReadError)
			assert.equal(error.status, 503)
			assert.equal(error.code, 'upstream_unavailable')
			assert.ok(!error.message.includes('fixture-private-auth-context'))
			return true
		},
	)
})

void test('malformed successful upstream JSON returns a 502 with a request ID and no body details', async () => {
	let requests = 0
	const client = createReadOnlySchwabClient(auth, {
		fetch: async () => {
			requests++
			return new Response('fixture-invalid-json-body', {
				status: 200,
				headers: { 'x-request-id': 'fixture-json-request-id' },
			})
		},
	})
	await assert.rejects(
		client.marketData.quotes.getQuotes({ queryParams: { symbols: ['DEMO'] } }),
		(error: unknown) => {
			assert.ok(error instanceof SchwabReadError)
			assert.equal(error.status, 502)
			assert.equal(error.code, 'upstream_format')
			assert.equal(error.getRequestId(), 'fixture-json-request-id')
			assert.ok(!error.message.includes('fixture-invalid-json-body'))
			return true
		},
	)
	assert.equal(requests, 1)
})
