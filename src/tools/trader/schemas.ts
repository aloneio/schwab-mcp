import {
	GetOrdersParams,
	GetOrdersByAccountParams,
	GetTransactionsParams,
} from '@sudowealth/schwab-api'
import { z } from 'zod'
import { calendarDateSchema } from '../market/schemas'

function queryDate(defaultDays: number, endOfDay = false) {
	return z
		.union([calendarDateSchema, z.string().datetime({ offset: true })])
		.transform((value) => {
			const date = new Date(value)
			if (endOfDay && value.length === 10) date.setUTCHours(23, 59, 59, 999)
			return date.toISOString()
		})
		.default(() => {
			const date = new Date()
			date.setUTCDate(date.getUTCDate() + defaultDays)
			date.setUTCHours(
				endOfDay ? 23 : 0,
				endOfDay ? 59 : 0,
				endOfDay ? 59 : 0,
				endOfDay ? 999 : 0,
			)
			return date.toISOString()
		})
		.describe(
			endOfDay
				? 'Inclusive end: YYYY-MM-DD includes the entire UTC day through 23:59:59.999Z. An ISO datetime with timezone specifies the exact instant; omitted defaults to the end of today in UTC.'
				: `Start: YYYY-MM-DD starts at 00:00:00.000Z in UTC. An ISO datetime with timezone specifies the exact instant; omitted defaults to ${-defaultDays} days ago in UTC.`,
		)
}

const maxResults = z.number().int().min(1).max(3000).optional()

export const OrdersParams = GetOrdersParams.extend({
	maxResults,
	fromEnteredTime: queryDate(-30),
	toEnteredTime: queryDate(0, true),
})

export const OrdersByAccountParams = GetOrdersByAccountParams.extend({
	maxResults,
	fromEnteredTime: queryDate(-60),
	toEnteredTime: queryDate(0, true),
})

export const TransactionsParams = GetTransactionsParams.extend({
	accountNumber: GetTransactionsParams.shape.accountNumber.min(1).optional(),
	startDate: queryDate(-30),
	endDate: queryDate(0, true),
})
