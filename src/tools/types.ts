import { type SchwabApiClient } from '@sudowealth/schwab-api'
import { type z } from 'zod'
import { type moversQuerySchema } from './market/schemas'

export const READ_ONLY_TOOL_NAMES = [
	'getAccounts',
	'getAccountNumbers',
	'getAccount',
	'getOrders',
	'getOrdersByAccountNumber',
	'getOrder',
	'getTransactions',
	'getTransaction',
	'getUserPreference',
	'getQuotes',
	'getQuoteBySymbolId',
	'searchInstruments',
	'getInstrumentByCusip',
	'getMarketHours',
	'getMarketHoursByMarketId',
	'getMovers',
	'getOptionChain',
	'getOptionExpirationChain',
	'getPriceHistory',
] as const

export type ReadOnlyToolName = (typeof READ_ONLY_TOOL_NAMES)[number]
type Trader = SchwabApiClient['trader']
type Market = SchwabApiClient['marketData']
type MarketId = 'equity' | 'option' | 'bond' | 'future' | 'forex'

/** JSON dates remain the upstream ISO strings or epoch numbers. */
export type WireData<T> = T extends Date
	? string | number
	: T extends readonly (infer Item)[]
		? WireData<Item>[]
		: T extends object
			? { [Key in keyof T]: WireData<T[Key]> }
			: T

type WireMethods<T, Keys extends keyof T> = {
	[Key in Keys]: T[Key] extends (...args: infer Args) => Promise<infer Result>
		? (...args: Args) => Promise<WireData<Result>>
		: never
}

/** Only the explicitly supported GET endpoints are available to tool handlers. */
export interface ReadOnlySchwabClient {
	trader: {
		accounts: WireMethods<
			Trader['accounts'],
			'getAccounts' | 'getAccountNumbers' | 'getAccountByNumber'
		>
		orders: WireMethods<
			Trader['orders'],
			'getOrders' | 'getOrdersByAccount' | 'getOrderByOrderId'
		>
		transactions: WireMethods<
			Trader['transactions'],
			'getTransactions' | 'getTransactionById'
		>
		userPreference: WireMethods<Trader['userPreference'], 'getUserPreference'>
	}
	marketData: {
		quotes: WireMethods<Market['quotes'], 'getQuotes' | 'getQuoteBySymbolId'>
		instruments: WireMethods<
			Market['instruments'],
			'getInstruments' | 'getInstrumentByCusip'
		>
		marketHours: {
			getMarketHours: (options: {
				queryParams: { markets: MarketId[]; date?: string }
			}) => Promise<
				WireData<Awaited<ReturnType<Market['marketHours']['getMarketHours']>>>
			>
			getMarketHoursByMarketId: (options: {
				pathParams: { market_id: MarketId }
				queryParams: { date?: string }
			}) => Promise<
				WireData<
					Awaited<ReturnType<Market['marketHours']['getMarketHoursByMarketId']>>
				>
			>
		}
		movers: {
			getMovers: (options: {
				pathParams: { symbol_id: string }
				queryParams: z.infer<typeof moversQuerySchema>
			}) => Promise<
				WireData<Awaited<ReturnType<Market['movers']['getMovers']>>>
			>
		}
		options: WireMethods<
			Market['options'],
			'getOptionChain' | 'getOptionExpirationChain'
		>
		priceHistory: WireMethods<Market['priceHistory'], 'getPriceHistory'>
	}
}

export interface ToolSpec<S extends z.AnyZodObject> {
	name: ReadOnlyToolName
	description: string
	schema: S
	call: (
		client: ReadOnlySchwabClient,
		params: z.infer<S>,
		context?: ToolContext,
	) => Promise<unknown>
}

export interface ToolContext {
	readonly signal: AbortSignal
}

/** Production creates a client bound to each call's cancellation signal. */
export type ReadClientSource =
	| ReadOnlySchwabClient
	| ((signal: AbortSignal) => ReadOnlySchwabClient)

// Factory function to create properly typed tool specs
export function createToolSpec<S extends z.AnyZodObject>(spec: {
	name: ReadOnlyToolName
	description: string
	schema: S
	call: (
		client: ReadOnlySchwabClient,
		params: z.infer<S>,
		context?: ToolContext,
	) => Promise<unknown>
}): ToolSpec<S> {
	return spec
}
