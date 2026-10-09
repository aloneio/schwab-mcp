import { type Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
	JSONRPCMessageSchema,
	type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js'

const MAX_MESSAGE_BYTES = 1024 * 1024

/** Legacy HTTP+SSE MCP transport; OAuth and session ownership are enforced by the caller. */
export class SchwabSseTransport implements Transport {
	onclose?: Transport['onclose']
	onerror?: Transport['onerror']
	onmessage?: Transport['onmessage']
	private controller!: ReadableStreamDefaultController<Uint8Array>
	private closed = false
	private started = false
	private heartbeat?: ReturnType<typeof setInterval>
	readonly stream: ReadableStream<Uint8Array>
	constructor(readonly sessionId: string) {
		this.stream = new ReadableStream({
			start: (controller) => {
				this.controller = controller
			},
			cancel: () => {
				this.finish()
			},
		})
	}
	async start() {
		if (this.closed || this.started)
			throw new Error('MCP session already started or closed')
		this.started = true
		this.enqueue(
			`event: endpoint\ndata: /sse/message?sessionId=${encodeURIComponent(this.sessionId)}\n\n`,
		)
		this.heartbeat = setInterval(() => {
			if (!this.closed) this.enqueue(': keepalive\n\n')
		}, 30_000)
	}
	get response() {
		return new Response(this.stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff',
			},
		})
	}
	private enqueue(text: string) {
		this.controller.enqueue(new TextEncoder().encode(text))
	}
	private finish() {
		if (this.closed) return
		this.closed = true
		clearInterval(this.heartbeat)
		this.onclose?.()
	}
	async close() {
		if (this.closed) return
		this.controller.close()
		this.finish()
	}
	async send(message: JSONRPCMessage) {
		if (this.closed) throw new Error('MCP session is closed')
		this.enqueue(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
	}
	async accept(request: Request): Promise<Response> {
		if (this.closed || !this.started)
			return new Response('Reconnect the MCP session.', { status: 410 })
		if (request.method !== 'POST')
			return new Response('Method not allowed', { status: 405 })
		if (
			request.headers
				.get('content-type')
				?.split(';')[0]
				?.trim()
				.toLowerCase() !== 'application/json'
		)
			return new Response('Expected JSON', { status: 415 })
		const reader = request.body?.getReader()
		if (!reader) return new Response('Expected a request body', { status: 400 })
		let length = 0
		let text = ''
		const decoder = new TextDecoder()
		try {
			while (true) {
				const chunk = await reader.read()
				if (chunk.done) break
				length += chunk.value.byteLength
				if (length > MAX_MESSAGE_BYTES) {
					await reader.cancel()
					return new Response('Message too large', { status: 413 })
				}
				text += decoder.decode(chunk.value, { stream: true })
			}
			text += decoder.decode()
			const message = JSONRPCMessageSchema.parse(JSON.parse(text))
			this.onmessage?.(message)
			return new Response(null, { status: 202 })
		} catch {
			return new Response('Invalid MCP message', { status: 400 })
		} finally {
			reader.releaseLock()
		}
	}
}
