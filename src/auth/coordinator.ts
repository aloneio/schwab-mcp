import { DurableObject } from 'cloudflare:workers'
import { type Env } from '../../types/env'
import { SchwabAuthService } from './service'

export class SchwabAuthCoordinator extends DurableObject<Env> {
	private readonly service: SchwabAuthService
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.service = new SchwabAuthService(ctx.storage, env)
	}

	override fetch(request: Request): Promise<Response> {
		return this.service.fetch(request)
	}

	async alarm(): Promise<void> {
		await this.service.alarm()
	}
}
