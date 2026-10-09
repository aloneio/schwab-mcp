import { z } from 'zod'
import { type Env, type ValidatedEnv } from '../../types/env'
import { configureLogger, logger } from '../shared/log'

const envSchema = z.object({
	SCHWAB_CLIENT_ID: z
		.string({
			required_error: 'SCHWAB_CLIENT_ID is required for OAuth authentication',
		})
		.min(1, 'SCHWAB_CLIENT_ID cannot be empty'),

	SCHWAB_CLIENT_SECRET: z
		.string({
			required_error:
				'SCHWAB_CLIENT_SECRET is required for OAuth authentication',
		})
		.min(1, 'SCHWAB_CLIENT_SECRET cannot be empty'),

	COOKIE_ENCRYPTION_KEY: z
		.string({
			required_error:
				'COOKIE_ENCRYPTION_KEY is required for browser cookie signatures',
		})
		.refine((value) => new TextEncoder().encode(value).length >= 32, {
			message: 'COOKIE_ENCRYPTION_KEY must contain at least 32 UTF-8 bytes',
		}),

	SCHWAB_REDIRECT_URI: z
		.string({
			required_error: 'SCHWAB_REDIRECT_URI is required for OAuth callback',
		})
		.url('SCHWAB_REDIRECT_URI must be a valid URL')
		.refine((value) => {
			try {
				const url = new URL(value)
				return (
					url.protocol === 'https:' &&
					url.pathname === '/callback' &&
					!url.username &&
					!url.password &&
					!url.search &&
					!url.hash
				)
			} catch {
				return false
			}
		}, 'SCHWAB_REDIRECT_URI must be an HTTPS /callback URL without credentials, query, or fragment'),

	OAUTH_KV: z.any().refine((v) => !!v, {
		message: 'OAUTH_KV binding is required for MCP OAuth clients and grants',
	}),

	SCHWAB_AUTH: z.any().refine((value) => !!value, {
		message: 'SCHWAB_AUTH Durable Object binding is required',
	}),

	LOG_LEVEL: z.preprocess(
		(value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
		z
			.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
			.default('info'),
	),

	ENVIRONMENT: z
		.enum(['development', 'staging', 'production'])
		.optional()
		.default('production'),
})

function buildConfigInternal(env: Env): ValidatedEnv {
	try {
		const validated = envSchema.parse(env)
		configureLogger(validated.LOG_LEVEL)
		return Object.freeze(validated) as ValidatedEnv
	} catch (error) {
		if (error instanceof z.ZodError) {
			const issues = error.issues
				.map((issue) => {
					const path = issue.path.join('.')
					return `  - ${path}: ${issue.message}`
				})
				.join('\n')

			const msg = `Environment validation failed:\n${issues}`
			logger.error(msg)
			throw new Error(msg)
		}
		throw error
	}
}

// Bindings are opaque runtime objects and must not be serialized or compared as JSON.
export const getConfig = buildConfigInternal
