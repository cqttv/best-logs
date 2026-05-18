import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { fetchStream } from '../utils/request.js';
import { logsService } from '../utils/logsService.js';
import { USER_AGENT, formatError, formatUsername, userChanRegex } from '../utils/helpers.js';

const NUMERIC_ID_REGEX = /^\d{1,20}$/;
const ALLOWED_CONTENT_TYPES = ['text/plain', 'application/json', 'application/octet-stream'];

function sendError(res: Response, status: number, message: string): void {
	res.status(status).contentType('text/plain').send(message);
}

async function proxyToInstance(res: Response, targetUrl: string): Promise<void> {
	const { body, statusCode, headers } = await fetchStream(targetUrl, {
		headers: { 'User-Agent': USER_AGENT },
		timeout: 120_000,
	});

	const contentType = headers['content-type'] ?? '';
	if (!ALLOWED_CONTENT_TYPES.some((t) => contentType.startsWith(t))) {
		sendError(res, 400, 'Invalid endpoint');
		return;
	}

	res.status(statusCode).contentType(contentType);
	if (body) {
		await pipeline(Readable.fromWeb(body), res);
	} else {
		res.end();
	}
}

function resolveChannelInput(req: Request): string | null {
	if (typeof req.query.channelid === 'string' && req.query.channelid) {
		return `id:${req.query.channelid}`;
	}
	if (typeof req.query.channel === 'string' && req.query.channel) {
		return formatUsername(req.query.channel);
	}
	return null;
}

function resolveUserInput(req: Request): string | null {
	if (typeof req.query.userid === 'string' && req.query.userid) {
		return `id:${req.query.userid}`;
	}
	if (typeof req.query.user === 'string' && req.query.user) {
		return formatUsername(req.query.user);
	}
	return null;
}

const router = Router();

router.get('/list', async (req: Request, res: Response) => {
	const rawChannelId = req.query.channelid;
	if (typeof rawChannelId === 'string' && rawChannelId && !NUMERIC_ID_REGEX.test(rawChannelId)) {
		sendError(res, 400, 'Invalid channel ID: must be numeric');
		return;
	}
	const rawUserId = req.query.userid;
	if (typeof rawUserId === 'string' && rawUserId && !NUMERIC_ID_REGEX.test(rawUserId)) {
		sendError(res, 400, 'Invalid user ID: must be numeric');
		return;
	}

	const channel = resolveChannelInput(req);

	if (!channel) {
		sendError(res, 400, 'Missing channel or channelid parameter');
		return;
	}
	if (!userChanRegex.test(channel)) {
		sendError(res, 400, 'Invalid channel or channel ID');
		return;
	}

	const user = resolveUserInput(req);
	if (user !== null && !userChanRegex.test(user)) {
		sendError(res, 400, 'Invalid user or user ID');
		return;
	}

	try {
		const data = await logsService.getInstance(channel, user, false);
		if (data.error) {
			sendError(res, data.status, data.error);
			return;
		}

		const instanceLink = data.userLogs.instances[0] ?? data.channelLogs.instances[0];
		const channelId = data.request.channel?.id;
		const userId = data.request.user?.id;

		if (!instanceLink || !channelId) {
			sendError(res, 404, 'No instance found');
			return;
		}

		let requestUrl = req.originalUrl.replace(/([?&])channel(?:id)?=[^&]*/i, `$1channelid=${channelId}`);
		if (userId) {
			requestUrl = requestUrl.replace(/([?&])user(?:id)?=[^&]*/i, `$1userid=${userId}`);
		}

		await proxyToInstance(res, `${instanceLink}${requestUrl}`);
	} catch (error) {
		if (res.headersSent) {
			res.destroy();
			return;
		}
		sendError(res, 500, formatError(error));
	}
});

const makeChannelLogsHandler =
	(isById: boolean) =>
	async (req: Request, res: Response): Promise<void> => {
		const rawUserId = req.query.userid;
		if (typeof rawUserId === 'string' && rawUserId && !NUMERIC_ID_REGEX.test(rawUserId)) {
			sendError(res, 400, 'Invalid user ID: must be numeric');
			return;
		}

		const endpoint = req.params.endpoint ?? '';
		const segments = endpoint.split('/').filter(Boolean);

		if (segments.length === 0) {
			sendError(res, 400, 'Missing channel');
			return;
		}

		const rawSegment = segments[0] ?? '';
		const channel = isById ? `id:${rawSegment}` : formatUsername(rawSegment);

		if (!userChanRegex.test(channel)) {
			sendError(res, 400, 'Invalid channel or channel ID');
			return;
		}

		let pathUser: string | null = null;
		const userKeyword = segments[1]?.toLowerCase();
		if (userKeyword === 'user' || userKeyword === 'userid') {
			const rawUser = segments[2];
			if (!rawUser) {
				sendError(res, 400, `Missing user after /${userKeyword}/`);
				return;
			}
			pathUser = userKeyword === 'userid' ? `id:${rawUser}` : formatUsername(rawUser);
		}

		const user = pathUser ?? resolveUserInput(req);
		if (user !== null && !userChanRegex.test(user)) {
			sendError(res, 400, 'Invalid user or user ID');
			return;
		}

		try {
			const data = await logsService.getInstance(channel, user, false);
			if (data.error) {
				sendError(res, data.status, data.error);
				return;
			}

			const instanceLink = data.userLogs.instances[0] ?? data.channelLogs.instances[0];
			const channelId = data.request.channel?.id;
			const userId = data.request.user?.id;

			if (!instanceLink || !channelId) {
				sendError(res, 404, 'No instance found');
				return;
			}

			let requestUrl = req.originalUrl.replace(/^\/channel(?:id)?\/[^/?]+/i, `/channelid/${channelId}`);
			if (userId) {
				requestUrl = requestUrl.replace(/([/?&])user(?:id)?([/=])[^/?&]+/i, `$1userid$2${userId}`);
			}

			await proxyToInstance(res, `${instanceLink}${requestUrl}`);
		} catch (error) {
			if (res.headersSent) {
				res.destroy();
				return;
			}
			sendError(res, 500, formatError(error));
		}
	};

router.get('/channel/:endpoint(*)', makeChannelLogsHandler(false));
router.get('/channelid/:endpoint(*)', makeChannelLogsHandler(true));

export default router;
