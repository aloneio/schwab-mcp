import { type SchwabAuthCoordinator } from '../src/auth/coordinator'

/**
 * Environment variables and bindings for the Schwab MCP worker
 *
 * This is the single source of truth for environment variable definitions.
 * In runtime, these variables are validated and accessed through AppConfig.
 */
export interface Env {
	/**
	 * Schwab OAuth client ID for API access
	 */
	SCHWAB_CLIENT_ID: string

	/**
	 * Schwab OAuth client secret for API access
	 */
	SCHWAB_CLIENT_SECRET: string

	/**
	 * At least 32 UTF-8 bytes of random secret material for browser cookie signatures
	 */
	COOKIE_ENCRYPTION_KEY: string

	/**
	 * OAuth redirect URI for callback after authentication
	 * This should be a fixed, configured value to ensure consistency
	 * across different environments and proxies
	 */
	SCHWAB_REDIRECT_URI: string

	/**
	 * KV namespace for MCP OAuth clients and grants (not Schwab credentials)
	 */
	OAUTH_KV: KVNamespace

	/** Serializes OAuth transactions and per-user Schwab token operations. */
	SCHWAB_AUTH: DurableObjectNamespace<SchwabAuthCoordinator>

	/**
	 * Optional log level for application logging
	 */
	LOG_LEVEL?: string

	/**
	 * Environment type (development, staging, production)
	 * Defaults to production if not specified
	 */
	ENVIRONMENT?: string

	/**
	 * Optional comma-separated list of additional redirect URI regex patterns
	 */
	ALLOWED_REDIRECT_REGEXPS?: string
}

/**
 * A validated Env object, with all required fields validated to be non-empty
 * Used to pass around a validated set of environment variables
 * All properties are readonly to prevent accidental modification after validation
 */
export interface ValidatedEnv {
	/**
	 * Schwab OAuth client ID for API access
	 */
	readonly SCHWAB_CLIENT_ID: string

	/**
	 * Schwab OAuth client secret for API access
	 */
	readonly SCHWAB_CLIENT_SECRET: string

	/**
	 * At least 32 UTF-8 bytes of random secret material for browser cookie signatures
	 */
	readonly COOKIE_ENCRYPTION_KEY: string

	/**
	 * OAuth redirect URI for callback after authentication
	 */
	readonly SCHWAB_REDIRECT_URI: string

	/**
	 * KV namespace for MCP OAuth clients and grants (not Schwab credentials)
	 */
	readonly OAUTH_KV: KVNamespace

	readonly SCHWAB_AUTH: DurableObjectNamespace<SchwabAuthCoordinator>

	/**
	 * Optional log level for application logging
	 */
	readonly LOG_LEVEL?: string

	/**
	 * Environment type (development, staging, production)
	 * Defaults to production if not specified
	 */
	readonly ENVIRONMENT?: 'development' | 'staging' | 'production'

	/**
	 * Optional comma-separated list of additional redirect URI regex patterns
	 */
	readonly ALLOWED_REDIRECT_REGEXPS?: string
}
