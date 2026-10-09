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
		.transform((value) => new Date(value).toISOString())
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
