import { request as httpRequest } from './request.js';
import { USER_AGENT } from './helpers.js';
import { config } from './config.js';
import { TTLCache } from './cache.js';
import type { Channel, LogsAvailabilityDate } from '../types/instance.js';

interface ChannelsBody {
	channels: Channel[];
}

export class InstanceLoader {
	readonly instanceCounts = new Map<string, number>();
	readonly instanceChannels = new Map<string, Channel[]>();
	readonly instanceChannelSets = new Map<string, Set<string>>();
	uniqueChannels = new Map<string, Channel>();
	uniqueChannelsArray: Channel[] = [];
	lastUpdated = Date.now();
	readonly reloadInterval = 1 * 60 * 60 * 1000;

	readonly listData = new TTLCache<string, LogsAvailabilityDate[]>({
		ttl: 10 * 60 * 1000,
		sweepInterval: 5 * 60 * 1000,
		maxSize: 100_000,
	});
	readonly statusCodes = new TTLCache<string, number>({
		ttl: 5 * 60 * 1000,
		sweepInterval: 5 * 60 * 1000,
		maxSize: 200_000,
	});

	private readonly errorInterval = 1 * 60 * 1000;
	private errorLoop: ReturnType<typeof setInterval> | null = null;
	private loadLoop: ReturnType<typeof setInterval> | null = null;
	private forceLoadPromise: Promise<void> | null = null;

	addChannel(channel: Channel): void {
		if (!this.uniqueChannels.has(channel.userID)) {
			this.uniqueChannels.set(channel.userID, channel);
			this.uniqueChannelsArray.push(channel);
		}
	}

	async loadInstanceChannels(noLogs?: boolean, onlyError?: boolean): Promise<void> {
		let instances = config.instances;

		if (onlyError) {
			instances = instances.filter(({ host }) => {
				const count = this.instanceCounts.get(host);
				return count === 0 || count === undefined;
			});
		}

		if (instances.length === 0) {
			if (!noLogs && !onlyError) {
				console.log(`[Logs] No instances found`);
			}
			return;
		}

		const loadedChannels = new Map<string, Channel>();

		let instancesWorking = 0;
		await Promise.allSettled(
			instances.map(async ({ host, apiHost }) => {
				try {
					const response = await httpRequest(`https://${apiHost}/channels`, {
						headers: { 'User-Agent': USER_AGENT },
						timeout: 10_000,
					});

					const logsData = JSON.parse(response.body) as ChannelsBody;
					if (logsData.channels.length === 0) throw new Error('No channels found');

					const currentInstanceChannels = logsData.channels;

					const channelSet = new Set<string>();
					for (const channel of currentInstanceChannels) {
						channelSet.add(channel.name);
						channelSet.add(channel.userID);
						loadedChannels.set(channel.userID, channel);
					}

					this.instanceCounts.set(host, currentInstanceChannels.length);
					this.instanceChannels.set(host, currentInstanceChannels);
					this.instanceChannelSets.set(host, channelSet);
					instancesWorking++;

					if (!noLogs) {
						console.log(`[${host}] Loaded ${String(currentInstanceChannels.length)} channels`);
					}
				} catch (error_) {
					const msg = error_ instanceof Error ? error_.message : String(error_);
					const error = error_ instanceof SyntaxError ? 'Invalid JSON' : msg;
					if (!noLogs) {
						console.error(`[${host}] Failed loading channels: ${error}`);
					}
					this.instanceCounts.set(host, 0);
					this.instanceChannels.set(host, []);
					this.instanceChannelSets.set(host, new Set<string>());
				}
			}),
		);

		if (onlyError) {
			for (const [id, channel] of loadedChannels) {
				if (!this.uniqueChannels.has(id)) {
					this.uniqueChannels.set(id, channel);
					this.uniqueChannelsArray.push(channel);
				}
			}
		} else if (instancesWorking > 0) {
			this.uniqueChannels = loadedChannels;
			this.uniqueChannelsArray = [...loadedChannels.values()];
		}

		if (!onlyError && instancesWorking > 0) {
			this.listData.clear();
			this.statusCodes.clear();
			this.lastUpdated = Date.now();
		}

		if (!noLogs) {
			console.log(
				`[Logs] Loaded ${String(this.uniqueChannels.size)} unique channels from ${String(instancesWorking)}/${String(this.instanceCounts.size)} instances`,
			);
		}
	}

	startLoops(): void {
		clearInterval(this.loadLoop ?? undefined);
		this.loadLoop = setInterval(() => {
			void this.loadInstanceChannels();
		}, this.reloadInterval);

		void this.loopErrorInstanceChannels();
	}

	async loopLoadInstanceChannels(): Promise<void> {
		if (this.forceLoadPromise) return this.forceLoadPromise;
		this.forceLoadPromise = this.loadInstanceChannels(true).finally(() => {
			this.forceLoadPromise = null;
		});
		return this.forceLoadPromise;
	}

	async loopErrorInstanceChannels(): Promise<void> {
		clearInterval(this.errorLoop ?? undefined);

		await this.loadInstanceChannels(true, true);

		this.errorLoop = setInterval(() => {
			void this.loadInstanceChannels(true, true);
		}, this.errorInterval);
	}

	stopLoops(): void {
		clearInterval(this.loadLoop ?? undefined);
		clearInterval(this.errorLoop ?? undefined);
		this.loadLoop = null;
		this.errorLoop = null;
		this.listData.destroy();
		this.statusCodes.destroy();
	}
}

export const instanceLoader = new InstanceLoader();
