import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type z } from 'zod'
import { createTool, toolError, toolSuccess } from '../shared/toolBuilder'
import { allToolSpecs } from '../tools'
import { type ReadClientSource, type ToolSpec } from '../tools/types'

/** A new server per SSE session: reconnecting never registers tools twice. */
export function createMcpServer(client: ReadClientSource) {
	const server = new McpServer({ name: 'Schwab MCP', version: '0.2.1' })
	server.registerTool(
		'status',
		{
			description: 'Check the read-only Schwab MCP server status',
			inputSchema: {},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async () => ({
			content: [
				{ type: 'text', text: 'Schwab MCP is running in read-only mode.' },
			],
		}),
	)
	// Each schema/handler pair remains together while heterogeneous specs are registered.
	for (const spec of allToolSpecs as readonly ToolSpec<z.AnyZodObject>[]) {
		createTool(client, server, {
			name: spec.name,
			description: spec.description,
			schema: spec.schema,
			handler: async (params, c, context) => {
				try {
					const data = await spec.call(c, params, context)
					return toolSuccess({ data, source: spec.name })
				} catch (error) {
					if (context.signal.aborted) throw error
					return toolError(error, { source: spec.name })
				}
			},
		})
	}
	return server
}
