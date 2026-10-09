import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { type z } from 'zod'
import {
	type ReadOnlySchwabClient,
	type ReadClientSource,
	type ToolContext,
} from '../tools/types'
import { logger } from './log'

type ToolHandler<S extends z.AnyZodObject> = (
	input: z.infer<S>,
	client: ReadOnlySchwabClient,
	context: ToolContext,
) => Promise<ToolResponse>

type ToolResponse<T = unknown> =
	| { ok: true; data: T; message?: string }
	| { ok: false; error: Error; details?: Record<string, unknown> }

function isOk<T>(
	res: ToolResponse<T>,
): res is { ok: true; data: T; message?: string } {
	return res.ok
}

function formatResponse(response: ToolResponse): CallToolResult {
	// Handle ToolResponse format
	if ('ok' in response) {
		if (isOk(response)) {
			const dataToLog = 'data' in response ? response.data : null
			const message =
				('message' in response && response.message) ||
				(dataToLog && (dataToLog as any).message) ||
				'Operation successful'

			const content: Array<{ type: 'text'; text: string }> = [
				{ type: 'text', text: message },
			]

			// Only add data if it exists and isn't redundant with message
			if (dataToLog !== null && dataToLog !== undefined) {
				content.push({ type: 'text', text: JSON.stringify(dataToLog, null, 2) })
			}

			return { content }
		} else {
			let errorMessage = 'An error occurred'
			if ('error' in response && response.error) {
				errorMessage =
					response.error instanceof Error
						? response.error.message
						: String(response.error)
			}
			const content: Array<{ type: 'text'; text: string }> = [
				{ type: 'text', text: errorMessage },
			]
			if ('details' in response && response.details) {
				if (response.details.formattedDetails) {
					content.push({
						type: 'text',
						text: `Details: ${response.details.formattedDetails}`,
					})
				}
				const diagnosticInfo = {
					status: response.details.status,
					code: response.details.code,
					requestId: response.details.requestId,
				}
				if (Object.values(diagnosticInfo).some((val) => val !== undefined)) {
					content.push({
						type: 'text',
						text: `Diagnostic Info: ${JSON.stringify(diagnosticInfo)}`,
					})
				}
			}
			return { content, isError: true }
		}
	}
	return {
		content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
	}
}

function isSchwabApiError(error: any): boolean {
	return (
		error &&
		typeof error === 'object' &&
		(error.name === 'SchwabApiError' ||
			error.constructor?.name === 'SchwabApiError')
	)
}

function isAuthError(error: any): boolean {
	return (
		error &&
		typeof error === 'object' &&
		(error.name === 'SchwabAuthError' ||
			error.constructor?.name === 'SchwabAuthError')
	)
}

export function toolError(
	message: string | Error | unknown,
	details?: Record<string, any>,
): ToolResponse {
	const error = message instanceof Error ? message : new Error(String(message))
	let enhancedDetails = { ...details }
	if (isSchwabApiError(error) || isAuthError(error)) {
		const apiError = error as any
		enhancedDetails = {
			...enhancedDetails,
			status: apiError.status,
			code: apiError.code,
			parsedError: apiError.parsedError,
		}
		if (typeof apiError.getRequestId === 'function') {
			enhancedDetails.requestId = apiError.getRequestId()
		}
		if (typeof apiError.getFormattedDetails === 'function') {
			enhancedDetails.formattedDetails = apiError.getFormattedDetails()
		}
	}
	logger.error('Tool error', {
		message: error.message, // Log only message to avoid large objects in primary log
		details: enhancedDetails,
		stack: error.stack,
	})
	return { ok: false, error, details: enhancedDetails }
}

export function toolSuccess<T>({
	data,
	message,
	source,
}: {
	data: T
	message?: string
	source: string
}): ToolResponse<T> {
	const count = Array.isArray(data) ? data.length : 1
	logger.debug(`Tool success: ${source}`, {
		dataPreview: Array.isArray(data) ? `Array of ${count} items` : typeof data,
		count,
	})
	return { ok: true, data, message }
}

export function createTool<S extends z.AnyZodObject>(
	client: ReadClientSource,
	server: McpServer,
	{
		name,
		description,
		schema,
		handler,
	}: {
		name: string
		description: string
		schema: S
		handler: ToolHandler<S>
	},
) {
	server.registerTool(
		name,
		{
			description,
			inputSchema: schema.shape,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
			},
		},
		async (args: z.infer<S>, extra: ToolContext): Promise<CallToolResult> => {
			try {
				extra.signal.throwIfAborted()
				logger.info(`[ToolBuilder] Direct invocation of tool: ${name}`)
				// McpServer has already validated and transformed the input once.
				const scopedClient =
					typeof client === 'function' ? client(extra.signal) : client
				const result = await handler(args as z.infer<S>, scopedClient, {
					signal: extra.signal,
				})
				extra.signal.throwIfAborted()
				return formatResponse(result)
			} catch (error) {
				if (extra.signal.aborted)
					return {
						isError: true,
						content: [{ type: 'text', text: 'Request cancelled.' }],
					}
				logger.error(`Unexpected error in direct tool: ${name}`, {
					error: error instanceof Error ? error.message : String(error),
				})
				return formatResponse(
					toolError(
						error instanceof Error
							? error
							: new Error('Unknown error in direct tool call'),
						{ source: name },
					),
				)
			}
		},
	)
}
