import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
	buildAccountDisplayMap,
	scrubAccountIdentifiers,
} from '../src/shared/accountPrivacy'
import { createReadOnlySchwabClient } from '../src/shared/schwabReadClient'
import { createTool, toolSuccess } from '../src/shared/toolBuilder'
import {
	allToolSpecs,
	READ_ONLY_TOOL_NAMES,
	type ReadOnlySchwabClient,
	type ToolSpec,
} from '../src/tools'
import { calendarDateSchema } from '../src/tools/market/schemas'

const accounts = [
	{ accountNumber: '11112222', hashValue: 'demo-account-a' },
	{ accountNumber: '33334444', hashValue: 'demo-account-b' },
]
const preferences = {
	accounts: [
		{
			accountNumber: '11112222',
			nickName: 'Retirement',
			displayAcctId: '...2222',
		},
	],
	streamerInfo: [],
	offers: [],
}

function fixtureClient() {
	const calls: Array<{ endpoint: string; args: any }> = []
	function endpoint(name: string, result: unknown) {
		return async (args?: unknown) => {
			calls.push({ endpoint: name, args })
			return structuredClone(result)
		}
	}
	const client = {
		trader: {
			accounts: {
				getAccounts: endpoint('getAccounts', [
					{
						securitiesAccount: {
							accountNumber: '11112222',
							currentBalances: { cashBalance: 42 },
						},
					},
				]),
				getAccountNumbers: endpoint('getAccountNumbers', accounts),
				getAccountByNumber: endpoint('getAccount', {
					securitiesAccount: {
						accountNumber: '11112222',
						positions: [{ symbol: 'DEMO' }],
					},
				}),
			},
			orders: {
				getOrders: endpoint('getOrders', [
					{ accountNumber: 11112222, orderId: 1 },
				]),
				getOrdersByAccount: endpoint('getOrdersByAccountNumber', [
					{ accountNumber: 11112222, orderId: 1 },
				]),
				getOrderByOrderId: endpoint('getOrder', {
					accountNumber: 11112222,
					orderId: 1,
				}),
			},
			transactions: {
				getTransactions: endpoint('getTransactions', [
					{
						accountNumber: '11112222',
						activityId: 1,
						time: '2026-10-01T10:00:00.000Z',
					},
				]),
				getTransactionById: endpoint('getTransaction', {
					accountNumber: '11112222',
					activityId: 1,
					time: '2026-10-01T10:00:00.000Z',
				}),
			},
			userPreference: {
				getUserPreference: endpoint('getUserPreference', preferences),
			},
		},
		marketData: {
			quotes: {
				getQuotes: endpoint('getQuotes', {
					DEMO: { quote: { lastPrice: 42 } },
				}),
				getQuoteBySymbolId: endpoint('getQuoteBySymbolId', {
					DEMO: { quote: { lastPrice: 42 } },
				}),
			},
			instruments: {
				getInstruments: endpoint('searchInstruments', { instruments: [] }),
				getInstrumentByCusip: endpoint('getInstrumentByCusip', {
					instruments: [],
				}),
			},
			marketHours: {
				getMarketHours: endpoint('getMarketHours', { equity: {} }),
				getMarketHoursByMarketId: endpoint('getMarketHoursByMarketId', {
					equity: {},
				}),
			},
			movers: { getMovers: endpoint('getMovers', { screeners: [] }) },
			options: {
				getOptionChain: endpoint('getOptionChain', { symbol: 'DEMO' }),
				getOptionExpirationChain: endpoint('getOptionExpirationChain', {
					expirationList: [],
				}),
			},
			priceHistory: {
				getPriceHistory: endpoint('getPriceHistory', {
					symbol: 'DEMO',
					candles: [],
				}),
			},
		},
	} as unknown as ReadOnlySchwabClient
	return { client, calls }
}

async function connectTools(client: ReadOnlySchwabClient) {
	const server = new McpServer({ name: 'local-tools-test', version: '1.0.0' })
	for (const spec of allToolSpecs as Array<ToolSpec<any>>) {
		createTool(client, server, {
			...spec,
			handler: async (params, sdk) =>
				toolSuccess({ data: await spec.call(sdk, params), source: spec.name }),
		})
	}
	const mcp = new Client({ name: 'local-test-client', version: '1.0.0' })
	const [serverTransport, clientTransport] =
		InMemoryTransport.createLinkedPair()
	await server.connect(serverTransport)
	await mcp.connect(clientTransport)
	return {
		mcp,
		close: async () => {
			await mcp.close()
			await server.close()
		},
	}
}

const optionInput = {
	symbol: 'DEMO',
	contractType: 'CALL',
	strikeCount: 5,
	includeUnderlyingQuote: false,
	strategy: 'ANALYTICAL',
	interval: 1,
	strike: 100,
	range: 'OTM',
	fromDate: '2026-10-09',
	toDate: '2026-11-09',
	volatility: 20,
	underlyingPrice: 95,
	interestRate: 4,
	daysToExpiration: 30,
	expMonth: 'NOV',
	optionType: 'S',
	entitlement: 'NP',
}
const dateRange = {
	fromEnteredTime: '2026-09-01T00:00:00.000Z',
	toEnteredTime: '2026-10-01T00:00:00.000Z',
}
const transactionQuery = {
	startDate: '2026-09-01T00:00:00.000Z',
	endDate: '2026-10-01T00:00:00.000Z',
	types: 'TRADE',
	symbol: 'DEMO',
}

const cases: Array<{
	name: string
	input: Record<string, unknown>
	expected: unknown
}> = [
	{
		name: 'getAccounts',
		input: { fields: 'positions' },
		expected: { queryParams: { fields: 'positions' } },
	},
	{ name: 'getAccountNumbers', input: {}, expected: {} },
	{
		name: 'getAccount',
		input: { accountNumber: 'demo-account-a', fields: 'positions' },
		expected: {
			pathParams: { accountNumber: 'demo-account-a' },
			queryParams: { fields: 'positions' },
		},
	},
	{
		name: 'getOrders',
		input: { ...dateRange, maxResults: 10, status: 'FILLED' },
		expected: {
			queryParams: { ...dateRange, maxResults: 10, status: 'FILLED' },
		},
	},
	{
		name: 'getOrdersByAccountNumber',
		input: { accountNumber: 'demo-account-a', ...dateRange, maxResults: 10 },
		expected: {
			pathParams: { accountNumber: 'demo-account-a' },
			queryParams: { ...dateRange, maxResults: 10 },
		},
	},
	{
		name: 'getOrder',
		input: { accountNumber: 'demo-account-a', orderId: 1 },
		expected: { pathParams: { accountNumber: 'demo-account-a', orderId: 1 } },
	},
	{
		name: 'getTransactions',
		input: transactionQuery,
		expected: {
			pathParams: { accountNumber: 'demo-account-a' },
			queryParams: transactionQuery,
		},
	},
	{
		name: 'getTransaction',
		input: { accountNumber: 'demo-account-a', transactionId: 1 },
		expected: {
			pathParams: { accountNumber: 'demo-account-a', transactionId: 1 },
		},
	},
	{ name: 'getUserPreference', input: {}, expected: {} },
	{
		name: 'getQuotes',
		input: {
			symbols: ['DEMO', 'SAMPLE'],
			fields: ['quote', 'reference'],
			indicative: false,
		},
		expected: {
			queryParams: {
				symbols: ['DEMO', 'SAMPLE'],
				fields: ['quote', 'reference'],
				indicative: false,
			},
		},
	},
	{
		name: 'getQuoteBySymbolId',
		input: { symbol_id: 'DEMO', fields: ['quote'] },
		expected: {
			pathParams: { symbol_id: 'DEMO' },
			queryParams: { fields: ['quote'] },
		},
	},
	{
		name: 'searchInstruments',
		input: { symbol: 'DEMO', projection: 'symbol-search' },
		expected: { queryParams: { symbol: 'DEMO', projection: 'symbol-search' } },
	},
	{
		name: 'getInstrumentByCusip',
		input: { cusip_id: '000000000' },
		expected: { pathParams: { cusip_id: '000000000' } },
	},
	{
		name: 'getMarketHours',
		input: { markets: 'equity', date: '2026-10-09' },
		expected: { queryParams: { markets: ['equity'], date: '2026-10-09' } },
	},
	{
		name: 'getMarketHoursByMarketId',
		input: { market_id: 'equity', date: '2026-10-09' },
		expected: {
			pathParams: { market_id: 'equity' },
			queryParams: { date: '2026-10-09' },
		},
	},
	{
		name: 'getMovers',
		input: { symbol_id: '$SPX', sort: 'PERCENT_CHANGE_UP', frequency: 0 },
		expected: {
			pathParams: { symbol_id: '$SPX' },
			queryParams: { sort: 'PERCENT_CHANGE_UP', frequency: 0 },
		},
	},
	{
		name: 'getOptionChain',
		input: optionInput,
		expected: { queryParams: optionInput },
	},
	{
		name: 'getOptionExpirationChain',
		input: { symbol: 'DEMO' },
		expected: { queryParams: { symbol: 'DEMO' } },
	},
	{
		name: 'getPriceHistory',
		input: {
			symbol: 'DEMO',
			periodType: 'day',
			period: 5,
			frequencyType: 'minute',
			frequency: 5,
			startDate: '2026-09-01',
			endDate: '2026-10-01',
			needExtendedHoursData: false,
			needPreviousClose: true,
		},
		expected: {
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
		},
	},
]

void test('all 19 tools advertise read-only annotations and execute through real MCP transport', async (t) => {
	const fixture = fixtureClient()
	const session = await connectTools(fixture.client)
	t.after(session.close)
	const listed = await session.mcp.listTools()
	assert.deepEqual(
		listed.tools.map((tool) => tool.name).sort(),
		[...READ_ONLY_TOOL_NAMES].sort(),
	)
	assert.equal(cases.length, 19)
	for (const tool of listed.tools) {
		assert.equal(tool.annotations?.readOnlyHint, true, tool.name)
		assert.equal(tool.annotations?.destructiveHint, false, tool.name)
		assert.equal(tool.annotations?.idempotentHint, true, tool.name)
	}
	for (const item of cases) {
		await t.test(item.name, async () => {
			fixture.calls.length = 0
			const result = await session.mcp.callTool({
				name: item.name,
				arguments: item.input,
			})
			assert.notEqual(result.isError, true, JSON.stringify(result))
			assert.deepEqual(
				fixture.calls.find((call) => call.endpoint === item.name)?.args,
				item.expected,
			)
			assert.ok(Array.isArray(result.content) && result.content.length >= 1)
		})
	}
})

void test('transactions query all linked accounts or only the explicitly selected account', async (t) => {
	const fixture = fixtureClient()
	const session = await connectTools(fixture.client)
	t.after(session.close)
	await session.mcp.callTool({
		name: 'getTransactions',
		arguments: transactionQuery,
	})
	assert.deepEqual(
		fixture.calls
			.filter((call) => call.endpoint === 'getTransactions')
			.map((call) => call.args.pathParams.accountNumber),
		['demo-account-a', 'demo-account-b'],
	)
	fixture.calls.length = 0
	await session.mcp.callTool({
		name: 'getTransactions',
		arguments: { ...transactionQuery, accountNumber: 'demo-account-b' },
	})
	assert.deepEqual(
		fixture.calls
			.filter((call) => call.endpoint === 'getTransactions')
			.map((call) => call.args.pathParams.accountNumber),
		['demo-account-b'],
	)
})

void test('recent order and transaction queries supply date defaults and reject invalid dates', async (t) => {
	const fixture = fixtureClient()
	const session = await connectTools(fixture.client)
	t.after(session.close)
	for (const [name, args, start, end] of [
		['getOrders', {}, 'fromEnteredTime', 'toEnteredTime'],
		[
			'getOrdersByAccountNumber',
			{ accountNumber: 'demo-account-a' },
			'fromEnteredTime',
			'toEnteredTime',
		],
		['getTransactions', { types: 'TRADE' }, 'startDate', 'endDate'],
	] as const) {
		fixture.calls.length = 0
		const result = await session.mcp.callTool({ name, arguments: args })
		assert.notEqual(result.isError, true)
		const query = fixture.calls.find((call) => call.endpoint === name)!.args
			.queryParams
		assert.ok(Date.parse(query[start]) < Date.parse(query[end]))
		assert.match(query[start], /T00:00:00\.000Z$/)
		fixture.calls.length = 0
		const invalid = await session.mcp.callTool({
			name,
			arguments: { ...args, [start]: 'invalid date' },
		})
		assert.equal(invalid.isError, true)
		assert.equal(fixture.calls.length, 0)
	}
})

void test('MCP transforms inputs once and returns tool failures as errors', async (t) => {
	const { client } = fixtureClient()
	const server = new McpServer({ name: 'transform-test', version: '1.0.0' })
	let calls = 0
	createTool(client, server, {
		name: 'transformProbe',
		description: 'Local transform regression fixture',
		schema: z.object({
			date: z.string().transform((value) => new Date(value)),
		}),
		handler: async ({ date }) => {
			calls++
			assert.ok(date instanceof Date)
			return toolSuccess({ source: 'probe', data: date.toISOString() })
		},
	})
	createTool(client, server, {
		name: 'errorProbe',
		description: 'Local error fixture',
		schema: z.object({}),
		handler: async () => {
			throw new Error('Synthetic read failure')
		},
	})
	const mcp = new Client({ name: 'transform-client', version: '1.0.0' })
	const [a, b] = InMemoryTransport.createLinkedPair()
	await server.connect(a)
	await mcp.connect(b)
	t.after(async () => {
		await mcp.close()
		await server.close()
	})
	assert.notEqual(
		(
			await mcp.callTool({
				name: 'transformProbe',
				arguments: { date: '2026-10-09' },
			})
		).isError,
		true,
	)
	assert.equal(calls, 1)
	assert.equal(
		(await mcp.callTool({ name: 'errorProbe', arguments: {} })).isError,
		true,
	)
})

void test('calendar validation rejects invalid dates before invoking any endpoint', async (t) => {
	assert.equal(calendarDateSchema.safeParse('2026-02-29').success, false)
	assert.equal(calendarDateSchema.safeParse('2028-02-29').success, true)
	const fixture = fixtureClient()
	const session = await connectTools(fixture.client)
	t.after(session.close)
	const result = await session.mcp.callTool({
		name: 'getMarketHours',
		arguments: { markets: ['equity'], date: '2026-02-31' },
	})
	assert.equal(result.isError, true)
	assert.equal(fixture.calls.length, 0)
})

void test('MCP market hours and movers reach the HTTP boundary with valid wire parameters', async (t) => {
	const requests: Request[] = []
	const client = createReadOnlySchwabClient(
		{
			getAccessToken: async () => 'local-fixture-token',
			refreshIfNeeded: async () => {
				throw new Error('No refresh expected in this fixture')
			},
			invalidateIfCurrent: async () => {
				throw new Error('No invalidation expected in this fixture')
			},
		},
		{
			fetch: async (input, init) => {
				const request = new Request(input, init)
				requests.push(request)
				return Response.json(
					new URL(request.url).pathname.includes('/movers/')
						? { screeners: [] }
						: {
								equity: {
									EQ: {
										date: '2026-10-09',
										marketType: 'EQUITY',
										isOpen: true,
									},
								},
							},
				)
			},
		},
	)
	const session = await connectTools(client)
	t.after(session.close)
	for (const [name, args] of [
		['getMarketHours', { markets: ['equity', 'option'], date: '2026-10-09' }],
		['getMarketHoursByMarketId', { market_id: 'equity', date: '2026-10-09' }],
		['getMovers', { symbol_id: '$SPX', sort: 'VOLUME', frequency: 0 }],
	] as const) {
		const result = await session.mcp.callTool({ name, arguments: args })
		assert.notEqual(result.isError, true, JSON.stringify(result))
	}
	assert.equal(requests.length, 3)
	for (const request of requests) {
		assert.equal(request.method, 'GET')
		assert.equal(request.redirect, 'manual')
	}
	assert.deepEqual(new URL(requests[0]!.url).searchParams.getAll('markets'), [
		'equity,option',
	])
	assert.equal(new URL(requests[0]!.url).searchParams.get('date'), '2026-10-09')
	assert.equal(new URL(requests[1]!.url).searchParams.get('date'), '2026-10-09')
	assert.equal(new URL(requests[2]!.url).searchParams.get('sort'), 'VOLUME')
})

void test('privacy handles numeric and string IDs, unknown IDs, nested records, and Date values', () => {
	const displayMap = new Map([
		['11112222', 'Retirement'],
		['demo-account-a', 'Retirement'],
	])
	const original = {
		accountNumber: 11112222,
		nested: [
			{
				hashValue: 'demo-account-a',
				time: new Date('2026-10-01T10:00:00.000Z'),
			},
			{ accountNumber: '99990000' },
		],
		note: 'Account 11112222',
		balance: 42,
	}
	assert.deepEqual(scrubAccountIdentifiers(original, displayMap), {
		accountDisplay: 'Retirement',
		nested: [
			{ accountDisplay: 'Retirement', time: '2026-10-01T10:00:00.000Z' },
			{ accountDisplay: 'Account' },
		],
		note: 'Account Retirement',
		balance: 42,
	})
	assert.equal(original.accountNumber, 11112222)
})

void test('account display fallbacks remain safe when preferences are missing or unavailable', async () => {
	const fixture = fixtureClient()
	let map = await buildAccountDisplayMap(fixture.client)
	assert.equal(map.get('11112222'), 'Retirement ...2222')
	assert.equal(map.get('33334444'), 'Account 2')
	fixture.client.trader.userPreference.getUserPreference = async () => {
		throw new Error('Synthetic preferences outage')
	}
	map = await buildAccountDisplayMap(fixture.client, accounts)
	assert.equal(map.get('11112222'), 'Account 1')
	assert.equal(map.get('33334444'), 'Account 2')
})

void test('MCP brokerage results preserve timestamps, hide raw IDs, and retain preferences without streaming', async (t) => {
	const fixture = fixtureClient()
	const session = await connectTools(fixture.client)
	t.after(session.close)
	for (const name of [
		'getOrders',
		'getTransactions',
		'getTransaction',
		'getUserPreference',
	]) {
		const args = cases.find((item) => item.name === name)!.input
		const result = await session.mcp.callTool({ name, arguments: args })
		const text = JSON.stringify(result)
		assert.ok(!text.includes('11112222'), name)
		if (name === 'getTransactions' || name === 'getTransaction')
			assert.ok(text.includes('2026-10-01T10:00:00.000Z'), name)
		if (name === 'getUserPreference')
			assert.ok(text.includes('streamerInfo'), name)
	}
})
