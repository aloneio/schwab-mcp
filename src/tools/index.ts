// Tool types
export * from './types'

// Auto-registration of tools
import * as market from './market'
import * as trader from './trader'
import { READ_ONLY_TOOL_NAMES } from './types'

export const allToolSpecs = [...trader.toolSpecs, ...market.toolSpecs]

const registeredNames = new Set(allToolSpecs.map((spec) => spec.name))
if (
	registeredNames.size !== allToolSpecs.length ||
	registeredNames.size !== READ_ONLY_TOOL_NAMES.length ||
	READ_ONLY_TOOL_NAMES.some((name) => !registeredNames.has(name))
) {
	throw new Error(
		'Tool registry does not match the explicit read-only tool allowlist',
	)
}
