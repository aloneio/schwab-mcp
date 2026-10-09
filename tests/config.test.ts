import assert from 'node:assert/strict'
import test from 'node:test'
import { getConfig } from '../src/config/appConfig'
import { type Env } from '../types/env'

const validEnv = (): Env => ({
	SCHWAB_CLIENT_ID: 'sample-client',
	SCHWAB_CLIENT_SECRET: 'sample-secret',
	COOKIE_ENCRYPTION_KEY: 'x'.repeat(32),
	SCHWAB_REDIRECT_URI: 'https://localhost:8788/callback',
	OAUTH_KV: {} as KVNamespace,
	SCHWAB_AUTH: {} as Env['SCHWAB_AUTH'],
})

await test('configuration applies production defaults and normalizes log level case', () => {
	const defaults = getConfig(validEnv())
	assert.equal(defaults.LOG_LEVEL, 'info')
	assert.equal(defaults.ENVIRONMENT, 'production')
	assert.equal(Object.isFrozen(defaults), true)
	assert.equal(
		getConfig({ ...validEnv(), LOG_LEVEL: ' DEBUG ' }).LOG_LEVEL,
		'debug',
	)
	assert.throws(
		() => getConfig({ ...validEnv(), LOG_LEVEL: 'verbose' }),
		/LOG_LEVEL/,
	)
})

await test('cookie signing material must contain at least 32 UTF-8 bytes', () => {
	assert.throws(
		() => getConfig({ ...validEnv(), COOKIE_ENCRYPTION_KEY: 'x'.repeat(31) }),
		/at least 32 UTF-8 bytes/,
	)
	assert.equal(
		getConfig({ ...validEnv(), COOKIE_ENCRYPTION_KEY: '界'.repeat(11) })
			.COOKIE_ENCRYPTION_KEY,
		'界'.repeat(11),
	)
})

await test('callback configuration matches the HTTPS route and secure browser cookie', () => {
	for (const callback of [
		'http://localhost:8788/callback',
		'https://worker.test/other',
		'https://worker.test/callback?extra=1',
		'https://worker.test/callback#fragment',
	]) {
		assert.throws(
			() => getConfig({ ...validEnv(), SCHWAB_REDIRECT_URI: callback }),
			/HTTPS \/callback URL/,
		)
	}
})

await test('opaque bindings are not serialized and each request uses its own bindings', () => {
	const first = validEnv()
	const binding = {
		toJSON: () => {
			throw new Error('binding must not be serialized')
		},
	}
	first.OAUTH_KV = binding as unknown as KVNamespace
	assert.equal(getConfig(first).OAUTH_KV, binding)
	const second = validEnv()
	assert.equal(getConfig(second).OAUTH_KV, second.OAUTH_KV)
	assert.notEqual(getConfig(first).OAUTH_KV, getConfig(second).OAUTH_KV)
})

await test('configuration rejects a missing authorization coordinator binding', () => {
	assert.throws(
		() =>
			getConfig({ ...validEnv(), SCHWAB_AUTH: undefined } as unknown as Env),
		/SCHWAB_AUTH Durable Object binding is required/,
	)
})
