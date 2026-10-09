import { type ReadOnlySchwabClient } from '../tools/types'

export type AccountDisplayMap = ReadonlyMap<string, string>
type AccountNumbers = Awaited<
	ReturnType<ReadOnlySchwabClient['trader']['accounts']['getAccountNumbers']>
>

/** Build labels without ever using the full account number as a fallback. */
export async function buildAccountDisplayMap(
	client: ReadOnlySchwabClient,
	knownAccounts?: AccountNumbers,
): Promise<AccountDisplayMap> {
	const [accounts, preferences] = await Promise.all([
		knownAccounts ?? client.trader.accounts.getAccountNumbers(),
		// A missing nickname must not prevent an otherwise successful read.
		client.trader.userPreference.getUserPreference().catch(() => undefined),
	])
	const identifiers = accounts.flatMap((account) => [
		account.accountNumber,
		account.hashValue,
	])
	const displayMap = new Map<string, string>()
	accounts.forEach((account, index) => {
		const preference = preferences?.accounts?.find(
			(item) => item.accountNumber === account.accountNumber,
		)
		const candidate = [preference?.nickName, preference?.displayAcctId]
			.filter(Boolean)
			.join(' ')
			.trim()
		const display =
			candidate && !identifiers.some((id) => id && candidate.includes(id))
				? candidate
				: `Account ${index + 1}`
		displayMap.set(account.accountNumber, display)
		displayMap.set(account.hashValue, display)
	})
	return displayMap
}

/** Remove identifiers regardless of whether the SDK represents them as numbers or strings. */
export function scrubAccountIdentifiers(
	data: unknown,
	displayMap: AccountDisplayMap,
): unknown {
	const identifiers = [...displayMap.keys()]
		.filter(Boolean)
		.sort((a, b) => b.length - a.length)
	function scrub(value: unknown): unknown {
		if (value instanceof Date) return value.toISOString()
		if (Array.isArray(value)) return value.map(scrub)
		if (value && typeof value === 'object') {
			const result: Record<string, unknown> = {}
			let accountDisplay: string | undefined
			for (const [key, entry] of Object.entries(value)) {
				if (key === 'accountNumber' || key === 'hashValue') {
					accountDisplay = displayMap.get(String(entry)) ?? 'Account'
				} else {
					Object.defineProperty(result, key, {
						value: scrub(entry),
						enumerable: true,
						configurable: true,
						writable: true,
					})
				}
			}
			if (accountDisplay) result.accountDisplay = accountDisplay
			return result
		}
		if (typeof value === 'string') {
			return identifiers.reduce(
				(text, id) => text.split(id).join(displayMap.get(id)!),
				value,
			)
		}
		return value
	}
	return scrub(data)
}
