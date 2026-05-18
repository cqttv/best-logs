import { request as httpRequest } from './request.js';
import { USER_AGENT } from './helpers.js';
import { config } from './config.js';
import { infoService } from './infoService.js';
import { TTLCache, InFlight } from './cache.js';
import type { NameHistoryEntry } from '../types/user.js';

export class NameHistoryService {
	private readonly cache = new TTLCache<string, NameHistoryEntry[]>({
		ttl: 10 * 60 * 1000,
		sweepInterval: 10 * 60 * 1000,
	});
	private readonly inFlight = new InFlight<string, NameHistoryEntry[]>();

	async getNameHistory(user: string): Promise<NameHistoryEntry[]> {
		if (!user.startsWith('login:') && Number.isNaN(Number(user))) {
			throw Object.assign(
				new Error(
					"The value must be an ID or use 'login:' to refer to usernames. Example: 754201843 or login:zonianmidian",
				),
				{ status: 400 },
			);
		}

		if (user.startsWith('login:')) {
			const userInfo = await infoService.getInfo(user.slice('login:'.length).toLowerCase());
			user = userInfo.id;
		}

		const cached = this.cache.get(user);
		if (cached !== undefined) return cached;

		return this.inFlight.run(user, () => this.fetch(user));
	}

	private async fetch(userId: string): Promise<NameHistoryEntry[]> {
		const nameHistoryMap = new Map<string, NameHistoryEntry>();

		const results = await Promise.allSettled(
			config.instances.map(async ({ host, apiHost }) => {
				try {
					const historyData = await httpRequest(`https://${apiHost}/namehistory/${userId}`, {
						headers: { 'User-Agent': USER_AGENT },
						timeout: 10_000,
					});

					const historyBody = JSON.parse(historyData.body) as NameHistoryEntry[];
					if (historyData.statusCode !== 200 || !Array.isArray(historyBody)) return false;

					console.log(`[${host}] Found ${String(historyBody.length)} registered usernames for ID ${userId}`);

					for (const entry of historyBody) {
						const existing = nameHistoryMap.get(entry.user_login);
						if (existing) {
							if (entry.last_timestamp > existing.last_timestamp) existing.last_timestamp = entry.last_timestamp;
							if (entry.first_timestamp < existing.first_timestamp) existing.first_timestamp = entry.first_timestamp;
						} else {
							nameHistoryMap.set(entry.user_login, { ...entry });
						}
					}
					return true;
				} catch {
					return false;
				}
			}),
		);

		const nameHistory = [...nameHistoryMap.values()].toSorted((a, b) =>
			a.last_timestamp < b.last_timestamp ? -1 : a.last_timestamp > b.last_timestamp ? 1 : 0,
		);

		console.log(`[NameHistory] Found ${String(nameHistory.length)} unique usernames for ID ${userId}`);

		const anySuccess = results.some((result) => result.status === 'fulfilled' && result.value);
		if (anySuccess) this.cache.set(userId, nameHistory);
		return nameHistory;
	}
}

export const nameHistoryService = new NameHistoryService();
