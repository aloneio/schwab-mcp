import {
	GetMarketHoursParams,
	GetMarketHoursByMarketIdParams,
	GetPriceHistoryParams,
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

function priceHistoryDate(endOfDay = false) {
	return z
		.union([z.number().int(), calendarDateSchema, z.null()])
		.optional()
		.transform((value) => {
			if (value === null || value === undefined) return undefined
			if (typeof value === 'number') return value
			const date = new Date(value)
			if (endOfDay) date.setUTCHours(23, 59, 59, 999)
			return date.getTime()
		})
		.describe(
			endOfDay
				? 'End date: a valid YYYY-MM-DD includes the entire UTC day (through 23:59:59.999Z); integer epoch milliseconds specify the exact instant. Null or omitted uses the upstream default.'
				: 'Start date: a valid YYYY-MM-DD starts at 00:00:00.000Z in UTC; integer epoch milliseconds specify the exact instant. Null or omitted uses the upstream default.',
		)
}

const priceHistoryDates = {
	startDate: priceHistoryDate(),
	endDate: priceHistoryDate(true),
}

export const PriceHistoryParams =
	GetPriceHistoryParams.extend(priceHistoryDates)

export const priceHistoryQuerySchema =
	marketData.priceHistory.GetPriceHistoryQueryParams.extend(priceHistoryDates)

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
