import { request as httpRequest } from './request.js';
import { USER_AGENT, userIdRegex } from './helpers.js';
import { TTLCache, InFlight } from './cache.js';
import { CircuitBreaker } from './circuitBreaker.js';
import type { UserInfo } from '../types/user.js';

interface IvrUserData {
	displayName: string;
	login: string;
	logo: string;
	id: string;
	banned: boolean;
}

const IVR_KEY = 'ivr';

export class InfoService {
	private readonly infoCache = new TTLCache<string, IvrUserData>({
		ttl: 60 * 60 * 1000,
		sweepInterval: 60_000,
		maxSize: 100_000,
	});
	private readonly negativeCache = new TTLCache<string, true>({
		ttl: 60_000,
		sweepInterval: 60_000,
		maxSize: 100_000,
	});
	private readonly inFlight = new InFlight<string, UserInfo>(20_000);
	private readonly circuit = new CircuitBreaker({ name: 'IVR', baseBlockMs: 10_000, maxBlockMs: 5 * 60_000 });

	async getInfo(user: string): Promise<UserInfo> {
		if (this.negativeCache.has(user)) throw new Error(`User not found: ${user}`);

		const cached = this.infoCache.get(user);
		if (cached !== undefined) return this.transform(cached);

		if (this.circuit.isOpen(IVR_KEY)) throw new Error('IVR API unavailable');

		return this.inFlight.run(user, () => this.fetch(user));
	}

	private async fetch(user: string): Promise<UserInfo> {
		const isId = userIdRegex.test(user);
		const params = new URLSearchParams({ [isId ? 'id' : 'login']: user.replace('id:', '') });
		let response;
		try {
			response = await httpRequest(`https://api.ivr.fi/v2/twitch/user?${params.toString()}`, {
				headers: { 'User-Agent': USER_AGENT },
				timeout: 5000,
			});
		} catch (error) {
			this.circuit.recordFailure(IVR_KEY);
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[IVR] Request failed: ${msg}`);
			throw error;
		}
		if (response.statusCode < 200 || response.statusCode > 299) {
			this.circuit.recordFailure(IVR_KEY);
			throw new Error(`IVR API error: ${String(response.statusCode)}`);
		}
		const body = JSON.parse(response.body) as IvrUserData[];
		const fetched = body[0];
		if (!fetched?.id) {
			this.negativeCache.set(user, true);
			throw new Error(`User not found: ${user}`);
		}
		this.circuit.recordSuccess(IVR_KEY);
		this.infoCache.set(user, fetched);
		return this.transform(fetched);
	}

	private transform(data: IvrUserData): UserInfo {
		const { displayName, login, logo: avatar, id, banned } = data;
		const name = displayName.toLowerCase() === login ? displayName : login;
		return { name, login, avatar, id, banned };
	}
}

export const infoService = new InfoService();
