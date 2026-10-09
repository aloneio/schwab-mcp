import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLogger, redactLogData } from '../src/shared/log'
import { logOnlyInDevelopment } from '../src/shared/secureLogger'

await test('log redaction covers nested objects, arrays and alternate field spellings', () => {
	const original = {
		items: [
			{
				headers: { Authorization: 'sample credential' },
				accountHash: 'sample hash',
			},
		],
		tokens: { access_token: 'sample access', refreshToken: 'sample refresh' },
		client: { CLIENT_SECRET: 'sample secret' },
		count: 3,
	}
	assert.deepEqual(redactLogData(original), {
		items: [
			{ headers: { Authorization: '[REDACTED]' }, accountHash: '[REDACTED]' },
		],
		tokens: { access_token: '[REDACTED]', refreshToken: '[REDACTED]' },
		client: { CLIENT_SECRET: '[REDACTED]' },
		count: 3,
	})
	assert.equal(original.tokens.access_token, 'sample access')
})

await test('redaction supports Headers, Error properties and circular data', () => {
	const error = Object.assign(
		new Error('request failed', { cause: { token: 'sample nested token' } }),
		{
			details: { accountNumber: 'sample account' },
		},
	)
	const data: Record<string, unknown> = {
		headers: new Headers({
			'Set-Cookie': 'sample cookie',
			accept: 'application/json',
		}),
		error,
	}
	data.self = data
	const cleaned = redactLogData(data) as typeof data
	assert.deepEqual(cleaned.headers, {
		'set-cookie': '[REDACTED]',
		accept: 'application/json',
	})
	assert.deepEqual((cleaned.error as typeof error).details, {
		accountNumber: '[REDACTED]',
	})
	assert.equal((cleaned.error as Error).message, 'request failed')
	assert.deepEqual((cleaned.error as Error).cause, { token: '[REDACTED]' })
	assert.equal(cleaned.self, '[Circular]')
})

await test('children created before configuration changes observe the new log level', () => {
	const entries: Array<{
		level: string
		data: Record<string, unknown>
		message: string
	}> = []
	const logger = buildLogger('info', (level, data, message) => {
		entries.push({ level, data, message })
	})
	const child = logger.child('auth')
	child.debug('hidden')
	logger.setLevel('debug')
	child.debug('visible', { accountHash: 'sample hash' })
	logger.setLevel('error')
	child.info('hidden again')
	child.error('failure')
	assert.deepEqual(entries, [
		{
			level: 'debug',
			data: { contextId: 'auth', data: { accountHash: '[REDACTED]' } },
			message: 'visible',
		},
		{ level: 'error', data: { contextId: 'auth' }, message: 'failure' },
	])
})

await test('development-only logging requires an explicit development environment', () => {
	const messages: string[] = []
	const logger = buildLogger('debug', (_level, _entry, message) =>
		messages.push(message),
	)
	logOnlyInDevelopment(logger, 'debug', 'default')
	logOnlyInDevelopment(logger, 'debug', 'production', undefined, 'production')
	logOnlyInDevelopment(logger, 'debug', 'staging', undefined, 'staging')
	logOnlyInDevelopment(logger, 'debug', 'development', undefined, 'development')
	assert.deepEqual(messages, ['development'])
})
