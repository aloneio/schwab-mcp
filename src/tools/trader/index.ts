import {
	GetAccountByNumberParams,
	GetAccountNumbersParams,
	GetAccountsParams,
	GetOrderByIdParams,
	GetTransactionByIdParams,
	GetUserPreferenceParams,
} from '@sudowealth/schwab-api'
import {
	buildAccountDisplayMap,
	scrubAccountIdentifiers,
} from '../../shared/accountPrivacy'
import { logger } from '../../shared/log'
import { createToolSpec } from '../types'
import {
	OrdersParams,
	OrdersByAccountParams,
	TransactionsParams,
} from './schemas'

export const toolSpecs = [
	createToolSpec({
		name: 'getAccounts',
		description: 'Get accounts',
		schema: GetAccountsParams,
		call: async (c, p) => {
			logger.info('[getAccounts] Fetching accounts', {
				showPositions: p?.fields,
			})
			const accounts = await c.trader.accounts.getAccounts({
				queryParams: { fields: p?.fields },
			})
			const accountSummaries = accounts.map((acc) => ({
				...acc.securitiesAccount,
			}))
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(accountSummaries, displayMap)
		},
	}),
	createToolSpec({
		name: 'getAccountNumbers',
		description:
			'Get safe account labels and opaque account hashes for account-specific queries',
		schema: GetAccountNumbersParams,
		call: async (c, p) => {
			logger.info('[getAccountNumbers] Fetching account numbers')
			const accounts = await c.trader.accounts.getAccountNumbers(p)
			const displayMap = await buildAccountDisplayMap(c, accounts)
			return accounts.map((acc) => {
				return {
					accountDisplay: displayMap.get(acc.accountNumber) ?? 'Account',
					hashValue: acc.hashValue,
				}
			})
		},
	}),
	createToolSpec({
		name: 'getAccount',
		description: 'Get account',
		schema: GetAccountByNumberParams,
		call: async (c, p) => {
			const account = await c.trader.accounts.getAccountByNumber({
				pathParams: { accountNumber: p.accountNumber },
				queryParams: { fields: p.fields },
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(account, displayMap)
		},
	}),
	createToolSpec({
		name: 'getOrders',
		description: 'Get orders',
		schema: OrdersParams,
		call: async (c, p) => {
			logger.info('[getOrders] Fetching orders', {
				maxResults: p.maxResults,
				hasDateFilter: !!p.fromEnteredTime || !!p.toEnteredTime,
			})
			const orders = await c.trader.orders.getOrders({ queryParams: p })
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(orders, displayMap)
		},
	}),
	createToolSpec({
		name: 'getOrdersByAccountNumber',
		description: 'Get orders by account number',
		schema: OrdersByAccountParams,
		call: async (c, p) => {
			const { accountNumber, ...queryParams } = p
			const orders = await c.trader.orders.getOrdersByAccount({
				pathParams: { accountNumber },
				queryParams,
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(orders, displayMap)
		},
	}),
	createToolSpec({
		name: 'getOrder',
		description: 'Get order by order id for a specific account',
		schema: GetOrderByIdParams,
		call: async (c, p) => {
			const order = await c.trader.orders.getOrderByOrderId({
				pathParams: { accountNumber: p.accountNumber, orderId: p.orderId },
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(order, displayMap)
		},
	}),
	createToolSpec({
		name: 'getTransactions',
		description:
			'Get transactions of the requested type. Omit accountNumber to read all linked accounts; provide an account hash to read only that account.',
		schema: TransactionsParams,
		call: async (c, p) => {
			logger.info('[getTransactions] Fetching accounts')
			const accounts = p.accountNumber
				? [{ hashValue: p.accountNumber }]
				: await c.trader.accounts.getAccountNumbers()
			if (accounts.length === 0) return []
			logger.info('[getTransactions] Fetching transactions', {
				accountCount: accounts.length,
				startDate: p.startDate,
				endDate: p.endDate,
				hasType: !!p.types,
				symbol: p.symbol,
			})
			const transactions: unknown[] = []
			for (const account of accounts) {
				const accountTransactions = await c.trader.transactions.getTransactions(
					{
						pathParams: { accountNumber: account.hashValue },
						queryParams: {
							startDate: p.startDate,
							endDate: p.endDate,
							types: p.types,
							symbol: p.symbol,
						},
					},
				)
				logger.debug('[getTransactions] Transactions for account', {
					count: accountTransactions.length,
				})
				transactions.push(...accountTransactions)
			}
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(transactions, displayMap)
		},
	}),
	createToolSpec({
		name: 'getTransaction',
		description: 'Get transaction',
		schema: GetTransactionByIdParams,
		call: async (c, p) => {
			logger.info('[getTransaction] Fetching transaction', {
				transactionId: p.transactionId,
			})
			const transaction = await c.trader.transactions.getTransactionById({
				pathParams: {
					accountNumber: p.accountNumber,
					transactionId: p.transactionId,
				},
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(transaction, displayMap)
		},
	}),
	createToolSpec({
		name: 'getUserPreference',
		description: 'Get user preference',
		schema: GetUserPreferenceParams,
		call: async (c, p) => {
			logger.info('[getUserPreference] Fetching user preference')
			const userPreference = await c.trader.userPreference.getUserPreference(p)
			logger.info('[getUserPreference] User preference fetched', {
				hasAccounts: userPreference.accounts?.length > 0,
				accountCount: userPreference.accounts?.length || 0,
				hasStreamerInfo: userPreference.streamerInfo?.length > 0,
			})
			const displayMap = await buildAccountDisplayMap(c)
			return scrubAccountIdentifiers(userPreference, displayMap)
		},
	}),
] as const
