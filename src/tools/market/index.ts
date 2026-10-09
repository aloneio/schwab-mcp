import {
	GetInstrumentByCusipParams,
	GetInstrumentsParams,
	GetOptionChainParams,
	GetOptionExpirationChainParams,
	GetQuoteBySymbolIdParams,
	GetQuotesParams,
} from '@sudowealth/schwab-api'
import { logger } from '../../shared/log'
import { createToolSpec } from '../types'
import {
	MarketHoursParams,
	MarketHoursByMarketIdParams,
	MoversParams,
	PriceHistoryParams,
} from './schemas'

export const toolSpecs = [
	createToolSpec({
		name: 'getQuotes',
		description: 'Get quotes for a list of symbols',
		schema: GetQuotesParams,
		call: async (c, p) => {
			logger.info('[getQuotes] Fetching quotes', {
				symbols: p.symbols,
				fields: p.fields,
			})
			return c.marketData.quotes.getQuotes({
				queryParams: {
					symbols: p.symbols,
					fields: p.fields,
					indicative: p.indicative,
				},
			})
		},
	}),
	createToolSpec({
		name: 'getQuoteBySymbolId',
		description: 'Get quote for a one symbol',
		schema: GetQuoteBySymbolIdParams,
		call: async (c, p) => {
			logger.info('[getQuoteBySymbolId] Fetching quote', {
				symbol_id: p.symbol_id,
				fields: p.fields,
			})
			const quoteData = await c.marketData.quotes.getQuoteBySymbolId({
				pathParams: { symbol_id: p.symbol_id },
				queryParams: { fields: p.fields },
			})
			return quoteData
		},
	}),
	createToolSpec({
		name: 'searchInstruments',
		description: 'Search for instruments by symbols and projections',
		schema: GetInstrumentsParams,
		call: (c, p) =>
			c.marketData.instruments.getInstruments({
				queryParams: p,
			}),
	}),
	createToolSpec({
		name: 'getInstrumentByCusip',
		description: 'Get instrument by cusip',
		schema: GetInstrumentByCusipParams,
		call: async (c, p) => {
			const instrument = await c.marketData.instruments.getInstrumentByCusip({
				pathParams: { cusip_id: p.cusip_id },
			})
			return instrument
		},
	}),
	createToolSpec({
		name: 'getMarketHours',
		description: 'Get market hours for different markets',
		schema: MarketHoursParams,
		call: (c, p) =>
			c.marketData.marketHours.getMarketHours({
				queryParams: {
					markets: p.markets,
					date: p.date,
				},
			}),
	}),
	createToolSpec({
		name: 'getMarketHoursByMarketId',
		description: 'Get market hours for a specific market',
		schema: MarketHoursByMarketIdParams,
		call: (c, p) =>
			c.marketData.marketHours.getMarketHoursByMarketId({
				pathParams: { market_id: p.market_id },
				queryParams: { date: p.date },
			}),
	}),
	createToolSpec({
		name: 'getMovers',
		description: 'Get movers for a specific index',
		schema: MoversParams,
		call: (c, p) =>
			c.marketData.movers.getMovers({
				pathParams: { symbol_id: p.symbol_id },
				queryParams: { sort: p.sort, frequency: p.frequency },
			}),
	}),
	createToolSpec({
		name: 'getOptionChain',
		description: 'Get option chain for an optionable symbol',
		schema: GetOptionChainParams,
		call: (c, p) =>
			c.marketData.options.getOptionChain({
				queryParams: p,
			}),
	}),
	createToolSpec({
		name: 'getOptionExpirationChain',
		description: 'Get option expiration chain for an optionable symbol',
		schema: GetOptionExpirationChainParams,
		call: (c, p) =>
			c.marketData.options.getOptionExpirationChain({
				queryParams: { symbol: p.symbol },
			}),
	}),
	createToolSpec({
		name: 'getPriceHistory',
		description: 'Get price history for a specific symbol and date range',
		schema: PriceHistoryParams,
		call: (c, p) =>
			c.marketData.priceHistory.getPriceHistory({
				queryParams: p,
			}),
	}),
] as const
