// Tool types
export * from './types'

// Auto-registration of tools
import * as market from './market'
import * as trader from './trader'

const WRITE_TRADING_TOOL_NAMES = new Set([
	'placeOrder',
	'replaceOrder',
	'cancelOrder',
])

export const allToolSpecs = [...trader.toolSpecs, ...market.toolSpecs]

const exposedWriteTradingTools = allToolSpecs.filter((spec) =>
	WRITE_TRADING_TOOL_NAMES.has(spec.name),
)

if (exposedWriteTradingTools.length > 0) {
	throw new Error(
		`Read-only policy violation: trading tools exposed: ${exposedWriteTradingTools
			.map((spec) => spec.name)
			.join(', ')}`,
	)
}
