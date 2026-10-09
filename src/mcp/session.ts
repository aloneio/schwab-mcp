export interface SessionOwner {
	schwabUserId: string
	clientId: string
}

export function readSessionOwner(props: unknown): SessionOwner | undefined {
	if (
		!props ||
		typeof props !== 'object' ||
		!('schwabUserId' in props) ||
		typeof props.schwabUserId !== 'string' ||
		!props.schwabUserId ||
		!('clientId' in props) ||
		typeof props.clientId !== 'string' ||
		!props.clientId
	)
		return undefined
	return { schwabUserId: props.schwabUserId, clientId: props.clientId }
}

export function sameSessionOwner(
	left?: SessionOwner,
	right?: SessionOwner,
): boolean {
	return (
		!!left &&
		!!right &&
		left.schwabUserId === right.schwabUserId &&
		left.clientId === right.clientId
	)
}
