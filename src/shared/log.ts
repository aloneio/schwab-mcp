import pino from 'pino'

export type PinoLogLevel =
	| 'trace'
	| 'debug'
	| 'info'
	| 'warn'
	| 'error'
	| 'fatal'

type LogMethod = 'debug' | 'info' | 'warn' | 'error'
type LogFunction = (message: string, data?: unknown, contextId?: string) => void
type ChildLogger = Record<LogMethod, LogFunction>

export interface AppLogger extends ChildLogger {
	child: (contextId: string) => ChildLogger
	setLevel: (level: PinoLogLevel) => void
}

type LogWriter = (
	level: LogMethod,
	entry: Record<string, unknown>,
	message: string,
) => void

const LEVELS: Record<PinoLogLevel, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
}

const SENSITIVE_KEYS = new Set([
	'password',
	'secret',
	'token',
	'key',
	'auth',
	'authorization',
	'proxyauthorization',
	'cookie',
	'setcookie',
	'session',
	'sessionid',
	'accesstoken',
	'refreshtoken',
	'idtoken',
	'credentials',
	'privatekey',
	'cookieencryptionkey',
	'apikey',
	'clientsecret',
	'schwabclientsecret',
	'schwabclientid',
	'schwabuserid',
	'clientid',
	'accountnumber',
	'accountid',
	'accounthash',
	'hashvalue',
	'schwabclientcorrelid',
	'sourcekey',
	'expectedkey',
	'tokenkey',
	'fromkey',
	'tokey',
	'state',
	'oauthstate',
	'code',
	'authorizationcode',
	'codeverifier',
])

/** Clean structured data before it reaches either Pino's Node or browser writer. */
export function redactLogData(value: unknown): unknown {
	const ancestors = new WeakSet<object>()
	const visit = (item: unknown): unknown => {
		if (typeof item !== 'object' || item === null) return item
		if (ancestors.has(item)) return '[Circular]'
		ancestors.add(item)
		try {
			if (item instanceof Date) return item.toISOString()
			if (Array.isArray(item)) return item.map(visit)
			const source =
				item instanceof Headers
					? Object.fromEntries(item.entries())
					: item instanceof Error
						? {
								...item,
								name: item.name,
								message: item.message,
								stack: item.stack,
								...(item.cause === undefined ? {} : { cause: item.cause }),
							}
						: item
			return Object.fromEntries(
				Object.entries(source).map(([key, entry]) => {
					const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
					return [
						key,
						SENSITIVE_KEYS.has(normalized) ? '[REDACTED]' : visit(entry),
					]
				}),
			)
		} finally {
			ancestors.delete(item)
		}
	}
	return visit(value)
}

/** Children share mutable level state and never capture obsolete Pino methods. */
export function buildLogger(
	level: PinoLogLevel = 'info',
	writer?: LogWriter,
): AppLogger {
	const baseLogger = writer
		? undefined
		: pino({
				level: 'trace',
				browser: { asObject: true },
				timestamp: pino.stdTimeFunctions.isoTime,
				base: { env: 'cloudflare-worker' },
			})
	const write: LogWriter =
		writer ?? ((method, entry, message) => baseLogger![method](entry, message))

	const methods = (contextId?: string): ChildLogger => {
		const method = (methodLevel: LogMethod): LogFunction => {
			return (message, data, additionalContextId) => {
				if (LEVELS[methodLevel] < LEVELS[level]) return
				write(
					methodLevel,
					{
						...(additionalContextId || contextId
							? { contextId: additionalContextId || contextId }
							: {}),
						...(data === undefined ? {} : { data: redactLogData(data) }),
					},
					message,
				)
			}
		}
		return {
			debug: method('debug'),
			info: method('info'),
			warn: method('warn'),
			error: method('error'),
		}
	}

	return {
		...methods(),
		child: methods,
		setLevel: (nextLevel) => {
			level = nextLevel
		},
	}
}

export const logger = buildLogger()

export function configureLogger(level: PinoLogLevel): void {
	logger.setLevel(level)
}
