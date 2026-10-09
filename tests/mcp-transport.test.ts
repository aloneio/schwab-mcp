import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { createMcpServer } from '../src/mcp/server'
import { readSessionOwner, sameSessionOwner } from '../src/mcp/session'
import { SchwabSseTransport } from '../src/mcp/transport'
import { createReadOnlySchwabClient } from '../src/shared/schwabReadClient'
import { READ_ONLY_TOOL_NAMES } from '../src/tools/types'

void test('the real SSE client discovers only read tools and calls status without a Schwab request', async () => {
	let upstreamCalls = 0
	const readClient = createReadOnlySchwabClient(
		{
			getAccessToken: async () => 'synthetic-access',
			refreshIfNeeded: async () => ({
				accessToken: 'synthetic-new',
				refreshToken: 'synthetic-refresh',
				expiresAt: Date.now() + 1800000,
			}),
			invalidateIfCurrent: async () => {
				throw new Error('No invalidation expected')
			},
		},
		{
			fetch: (async () => {
				upstreamCalls++
				throw new Error('No upstream call expected')
			}) as typeof fetch,
		},
	)
	const server = createMcpServer(readClient)
	const transport = new SchwabSseTransport('synthetic-session')
	await server.connect(transport)
	const client = new Client({ name: 'offline-check', version: '1.0.0' })
	const clientTransport = new SSEClientTransport(
		new URL('https://mcp.example/sse'),
		{
			fetch: async (url, init) => {
				const request = new Request(url, init)
				if (request.method === 'GET') return transport.response
				return transport.accept(request)
			},
		},
	)
	try {
		await client.connect(clientTransport)
		const listed = await client.listTools()
		assert.deepEqual(
			listed.tools.map((tool) => tool.name).sort(),
			[...READ_ONLY_TOOL_NAMES, 'status'].sort(),
		)
		for (const tool of listed.tools) {
			assert.equal(tool.annotations?.readOnlyHint, true)
			assert.equal(tool.annotations?.destructiveHint, false)
			assert.equal(tool.annotations?.idempotentHint, true)
		}
		const status = await client.callTool({ name: 'status', arguments: {} })
		assert.match(JSON.stringify(status.content), /read-only/)
		const unknown = await client.callTool({ name: 'placeOrder', arguments: {} })
		assert.equal(unknown.isError, true)
		assert.equal(upstreamCalls, 0)
	} finally {
		await client.close()
		await server.close()
	}
})

void test('SSE transport validates messages and closes idempotently', async () => {
	const transport = new SchwabSseTransport('sample')
	await transport.start()
	try {
		assert.equal(
			(
				await transport.accept(
					new Request('https://mcp.example/sse/message', { method: 'GET' }),
				)
			).status,
			405,
		)
		assert.equal(
			(
				await transport.accept(
					new Request('https://mcp.example/sse/message', {
						method: 'POST',
						body: '{}',
					}),
				)
			).status,
			415,
		)
		assert.equal(
			(
				await transport.accept(
					new Request('https://mcp.example/sse/message', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: '{}',
					}),
				)
			).status,
			400,
		)
		const accepted: unknown[] = []
		transport.onmessage = (message) => {
			accepted.push(message)
		}
		assert.equal(
			(
				await transport.accept(
					new Request('https://mcp.example/sse/message', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json; charset=utf-8' },
						body: JSON.stringify({
							jsonrpc: '2.0',
							id: 1,
							method: 'tools/list',
						}),
					}),
				)
			).status,
			202,
		)
		assert.equal(accepted.length, 1)
	} finally {
		await transport.close()
	}
	await transport.close()
	assert.equal(
		(await transport.accept(new Request('https://mcp.example/sse/message')))
			.status,
		410,
	)
})

void test('session ownership requires both authenticated user and client', () => {
	const owner = readSessionOwner({
		schwabUserId: 'user-a',
		clientId: 'client-a',
	})
	assert.ok(owner)
	assert.equal(
		sameSessionOwner(owner, { schwabUserId: 'user-a', clientId: 'client-a' }),
		true,
	)
	assert.equal(
		sameSessionOwner(owner, { schwabUserId: 'user-b', clientId: 'client-a' }),
		false,
	)
	assert.equal(
		sameSessionOwner(owner, { schwabUserId: 'user-a', clientId: 'client-b' }),
		false,
	)
	assert.equal(sameSessionOwner(undefined, undefined), false)
	assert.equal(readSessionOwner({ clientId: 'client-a' }), undefined)
})
