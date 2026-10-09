import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp/server'
import {
	createReadOnlySchwabClient,
	type ReadTokenProvider,
} from '../src/shared/schwabReadClient'

const auth: ReadTokenProvider = {
	getAccessToken: async () => 'fixture-access',
	refreshIfNeeded: async () => {
		throw new Error('Unexpected refresh')
	},
	invalidateIfCurrent: async () => {
		throw new Error('Unexpected invalidation')
	},
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

async function connect(fetchImpl: typeof fetch) {
	const server = createMcpServer((signal) =>
		createReadOnlySchwabClient(auth, { signal, fetch: fetchImpl }),
	)
	const client = new Client({ name: 'cancellation-fixture', version: '1.0.0' })
	const [serverTransport, clientTransport] =
		InMemoryTransport.createLinkedPair()
	await server.connect(serverTransport)
	await client.connect(clientTransport)
	return {
		client,
		server,
		serverTransport,
		close: async () => {
			await client.close()
			await server.close()
		},
	}
}

void test(
	'cancelling an MCP multi-account read aborts HTTP and prevents subsequent queries',
	{ timeout: 5000 },
	async () => {
		const started = deferred<void>()
		const aborted = deferred<void>()
		const calls: string[] = []
		const fixture = await connect(async (input) => {
			assert.ok(input instanceof Request)
			const path = new URL(input.url).pathname
			calls.push(path)
			if (path.endsWith('/accountNumbers'))
				return Response.json([
					{ accountNumber: '11112222', hashValue: 'fixture-a' },
					{ accountNumber: '33334444', hashValue: 'fixture-b' },
				])
			assert.equal(path, '/trader/v1/accounts/fixture-a/transactions')
			return new Promise<Response>((_resolve, reject) => {
				input.signal.addEventListener(
					'abort',
					() => {
						aborted.resolve()
						reject(input.signal.reason)
					},
					{ once: true },
				)
				started.resolve()
			})
		})
		try {
			const controller = new AbortController()
			const pending = fixture.client.callTool(
				{ name: 'getTransactions', arguments: { types: 'TRADE' } },
				undefined,
				{ signal: controller.signal },
			)
			const cancelled = assert.rejects(pending, /fixture request cancelled/)
			await started.promise
			controller.abort(new Error('fixture request cancelled'))
			await cancelled
			await aborted.promise
			await setImmediate()
			assert.deepEqual(calls, [
				'/trader/v1/accounts/accountNumbers',
				'/trader/v1/accounts/fixture-a/transactions',
			])
			const status = await fixture.client.callTool({
				name: 'status',
				arguments: {},
			})
			assert.notEqual(status.isError, true)
		} finally {
			await fixture.close()
		}
	},
)

void test(
	'one cancelled MCP call does not cancel another concurrent quote request',
	{ timeout: 5000 },
	async () => {
		const firstStarted = deferred<void>()
		const firstAborted = deferred<void>()
		const secondStarted = deferred<void>()
		const secondResponse = deferred<Response>()
		let secondSignal: AbortSignal | undefined
		const fixture = await connect(async (input) => {
			assert.ok(input instanceof Request)
			const symbol = new URL(input.url).searchParams.get('symbols')
			if (symbol === 'AAPL')
				return new Promise<Response>((_resolve, reject) => {
					input.signal.addEventListener(
						'abort',
						() => {
							firstAborted.resolve()
							reject(input.signal.reason)
						},
						{ once: true },
					)
					firstStarted.resolve()
				})
			assert.equal(symbol, 'MSFT')
			secondSignal = input.signal
			secondStarted.resolve()
			return secondResponse.promise
		})
		try {
			const controller = new AbortController()
			const first = fixture.client.callTool(
				{ name: 'getQuotes', arguments: { symbols: ['AAPL'] } },
				undefined,
				{ signal: controller.signal },
			)
			const cancelled = assert.rejects(first, /cancel only first/)
			await firstStarted.promise
			const second = fixture.client.callTool({
				name: 'getQuotes',
				arguments: { symbols: ['MSFT'] },
			})
			await secondStarted.promise
			controller.abort(new Error('cancel only first'))
			await cancelled
			await firstAborted.promise
			assert.equal(secondSignal?.aborted, false)
			secondResponse.resolve(
				Response.json({ MSFT: { quote: { lastPrice: 123.45 } } }),
			)
			const result = await second
			assert.notEqual(result.isError, true)
			assert.match(JSON.stringify(result), /123\.45/)
		} finally {
			secondResponse.resolve(Response.json({}))
			await fixture.close()
		}
	},
)

void test(
	'closing the MCP transport aborts an in-flight business read',
	{ timeout: 5000 },
	async () => {
		const started = deferred<void>()
		const aborted = deferred<void>()
		const fixture = await connect(async (input) => {
			assert.ok(input instanceof Request)
			return new Promise<Response>((_resolve, reject) => {
				input.signal.addEventListener(
					'abort',
					() => {
						aborted.resolve()
						reject(input.signal.reason)
					},
					{ once: true },
				)
				started.resolve()
			})
		})
		try {
			const pending = fixture.client.callTool({
				name: 'getQuotes',
				arguments: { symbols: ['AAPL'] },
			})
			const closed = assert.rejects(pending, /Connection closed/)
			await started.promise
			await fixture.serverTransport.close()
			await aborted.promise
			await closed
		} finally {
			await fixture.close()
		}
	},
)
