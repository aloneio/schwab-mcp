import {
	GetMarketHoursParams,
	GetMarketHoursByMarketIdParams,
	marketData,
} from '@sudowealth/schwab-api'
import { z } from 'zod'

/** Calendar dates stay strings across MCP and SDK validation and URL encoding. */
export const calendarDateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
	.refine((value) => {
		const date = new Date(value)
		return (
			!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
		)
	}, 'Date must be a valid calendar date')

export const MarketHoursParams = GetMarketHoursParams.extend({
	date: calendarDateSchema.optional(),
})

export const MarketHoursByMarketIdParams =
	GetMarketHoursByMarketIdParams.extend({
		date: calendarDateSchema.optional(),
	})

// The SDK 2.1.0 query schema accidentally uses the response direction enum for sort.
export const moversQuerySchema = z.object({
	sort: marketData.movers.MoversSortEnum.optional(),
	frequency: marketData.movers.MoversFrequencyEnum.optional(),
})

export const MoversParams = moversQuerySchema.extend({
	symbol_id: marketData.movers.MoversSymbolIdEnum,
})
