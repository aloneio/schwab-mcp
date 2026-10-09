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

// Only these free-text fields may contain an account reference in otherwise useful text.
// Structured business values (CUSIPs, symbols, timestamps, IDs, etc.) must stay intact.
const ACCOUNT_TEXT_FIELDS = new Set(['description', 'note', 'notes'])
const ACCOUNT_LABEL_FIELDS = new Set([
	'nickName',
	'displayAcctId',
	'accountDisplay',
])

/** Remove supported account fields and account references in known free-text fields. */
export function scrubAccountIdentifiers(
	data: unknown,
	displayMap: AccountDisplayMap,
): unknown {
	const identifiers = [...displayMap.keys()]
		.filter(Boolean)
		.sort((a, b) => b.length - a.length)
	const escapedIdentifiers = identifiers
		.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('|')
	const accountIdentifier = identifiers.length
		? new RegExp(escapedIdentifiers, 'g')
		: undefined
	const accountReference = identifiers.length
		? new RegExp(
				`(?<![A-Za-z0-9])(?:${escapedIdentifiers})(?![A-Za-z0-9])`,
				'g',
			)
		: undefined
	function scrub(value: unknown, field?: string): unknown {
		if (value instanceof Date) return value.toISOString()
		if (Array.isArray(value)) return value.map((entry) => scrub(entry, field))
		if (value && typeof value === 'object') {
			const result: Record<string, unknown> = {}
			let accountDisplay: string | undefined
			for (const [key, entry] of Object.entries(value)) {
				if (key === 'accountNumber' || key === 'hashValue') {
					accountDisplay = displayMap.get(String(entry)) ?? 'Account'
				} else {
					Object.defineProperty(result, key, {
						value: scrub(entry, key),
						enumerable: true,
						configurable: true,
						writable: true,
					})
				}
			}
			if (accountDisplay) result.accountDisplay = accountDisplay
			return result
		}
		if (typeof value === 'string' && field) {
			// Account labels may embed a number without spaces, e.g. "IRA11112222".
			const pattern = ACCOUNT_LABEL_FIELDS.has(field)
				? accountIdentifier
				: ACCOUNT_TEXT_FIELDS.has(field)
					? accountReference
					: undefined
			if (pattern) return value.replace(pattern, (id) => displayMap.get(id)!)
		}
		return value
	}
	return scrub(data)
}
