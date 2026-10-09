import { type AppLogger, redactLogData } from './log'

export function logOnlyInDevelopment(
	logger: Pick<AppLogger, 'debug' | 'info' | 'warn' | 'error'>,
	level: 'debug' | 'info' | 'warn' | 'error',
	message: string,
	data?: unknown,
	environment: string = 'production',
): void {
	if (environment === 'development') {
		logger[level](message, redactLogData(data))
	}
}
