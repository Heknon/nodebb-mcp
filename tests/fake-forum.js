/**
 * A fake NodeBB forum over real HTTP.
 *
 * Responses mirror the shapes NodeBB actually returns, including the parts that
 * bite: titles arrive HTML-escaped, post content arrives as rendered HTML, the
 * Write API wraps payloads in { status, response }, and /api/search 404s when no
 * search plugin is installed.
 *
 * `plugins` switches which optional features exist, which is how the degradation
 * paths get exercised without needing three forums.
 */

import http from 'node:http';

const TOPICS = {
	10: {
		tid: 10,
		title: 'Redis connection refused after upgrade &amp; restart',
		slug: '10/redis-connection-refused',
		cid: 3,
		category: { cid: 3, name: 'Support' },
		uid: 5,
		user: { uid: 5, username: 'reporter', userslug: 'reporter' },
		postcount: 3,
		viewcount: 240,
		timestamp: 1_700_000_000_000,
		tags: [{ value: 'redis' }, { value: 'upgrade' }],
		isQuestion: 1,
		isSolved: 1,
		solvedPid: 102,
		posts: [
			{
				pid: 100, index: 0, uid: 5, timestamp: 1_700_000_000_000,
				user: { uid: 5, username: 'reporter' },
				content: '<p>After upgrading, NodeBB won&#x27;t start. Log says <code>ECONNREFUSED 127.0.0.1:6379</code>.</p>',
			},
			{
				pid: 101, index: 1, uid: 7, timestamp: 1_700_000_100_000, votes: 0,
				user: { uid: 7, username: 'helper' },
				content: '<p>Is redis actually running?</p>',
			},
			{
				pid: 102, index: 2, uid: 8, timestamp: 1_700_000_200_000, votes: 12,
				user: { uid: 8, username: 'maintainer' },
				content: '<p>Start redis pointed at your data dir:</p><pre><code>redis-server --dir /var/lib/redis --appendonly yes</code></pre><p>Then restart NodeBB.</p>',
			},
		],
	},
	11: {
		tid: 11,
		title: 'Plugin symlink disappears after npm install',
		slug: '11/plugin-symlink-disappears',
		cid: 3,
		category: { cid: 3, name: 'Support' },
		uid: 6,
		user: { uid: 6, username: 'dev', userslug: 'dev' },
		postcount: 1,
		viewcount: 12,
		timestamp: 1_700_100_000_000,
		tags: [{ value: 'plugins' }],
		isQuestion: 1,
		isSolved: 0,
		posts: [
			{
				pid: 110, index: 0, uid: 6, timestamp: 1_700_100_000_000,
				user: { uid: 6, username: 'dev' },
				content: '<p>My plugin 404s and the log says it is active but not installed.</p>',
			},
		],
	},
	12: {
		tid: 12,
		title: 'Welcome to the forum',
		slug: '12/welcome',
		cid: 1,
		category: { cid: 1, name: 'General' },
		uid: 1,
		user: { uid: 1, username: 'admin', userslug: 'admin' },
		postcount: 2,
		viewcount: 900,
		timestamp: 1_699_000_000_000,
		tags: [],
		posts: [
			{ pid: 120, index: 0, uid: 1, timestamp: 1_699_000_000_000, user: { uid: 1, username: 'admin' }, content: '<p>Hello!</p>' },
			{ pid: 121, index: 1, uid: 2, timestamp: 1_699_000_100_000, votes: 3, user: { uid: 2, username: 'member' }, content: '<p>Glad to be here.</p>' },
		],
	},
};

/** Topic listing entries carry fewer fields than a full topic read. */
function summaryOf(topic, { qna }) {
	const base = {
		tid: topic.tid,
		title: topic.title,
		slug: topic.slug,
		cid: topic.cid,
		category: topic.category,
		uid: topic.uid,
		user: topic.user,
		postcount: topic.postcount,
		viewcount: topic.viewcount,
		timestamp: topic.timestamp,
		tags: topic.tags,
	};
	// The Q&A plugin decorates listings via filter:topics.get.
	if (qna && topic.isQuestion !== undefined) {
		base.isQuestion = topic.isQuestion;
		base.isSolved = topic.isSolved;
	}
	return base;
}

function topicPayload(topic, { qna }) {
	const payload = { ...summaryOf(topic, { qna }), posts: topic.posts.map(p => ({ ...p })) };
	if (qna && topic.isQuestion !== undefined) {
		payload.isQuestion = topic.isQuestion;
		payload.isSolved = topic.isSolved;
		payload.solvedPid = topic.solvedPid ?? 0;
		// filter:topic.getPosts marks the accepted answer.
		payload.posts = payload.posts.map(p => ({ ...p, isAnswer: p.pid === topic.solvedPid }));
	}
	return payload;
}

/**
 * Start a fake forum.
 *
 * @param {object} opts
 * @param {{search?:boolean,qna?:boolean,shotef?:boolean}} opts.plugins
 * @param {string} [opts.token] when set, requests must present this bearer token
 * @param {boolean} [opts.requireUid] emulate a master token needing _uid
 */
export async function startFakeForum(opts = {}) {
	const plugins = { search: true, qna: true, shotef: true, ...(opts.plugins ?? {}) };
	/** @type {{method:string,path:string,auth:string|undefined}[]} */
	const requests = [];

	const server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		const path = url.pathname;
		requests.push({
			method: req.method,
			path,
			query: Object.fromEntries(url.searchParams),
			auth: req.headers.authorization,
		});

		const json = (status, body) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		const v3 = (status, body) => json(status, {
			status: { code: status === 200 ? 'ok' : 'error', message: status === 200 ? 'OK' : 'Error' },
			response: body,
		});
		const notFound = () => {
			// NodeBB serves an HTML 404 page for unrouted paths.
			res.writeHead(404, { 'content-type': 'text/html' });
			res.end('<html>404</html>');
		};

		if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
			return json(401, { status: { code: 'not-authorised', message: '[[error:invalid-token]]' } });
		}
		if (opts.requireUid && !url.searchParams.has('_uid')) {
			return json(400, { status: { code: 'bad-request', message: '[[error:api.master-token-no-uid]]' } });
		}

		if (path === '/api/config') {
			return json(200, { version: '4.4.2', siteTitle: 'Fake Forum', csrf_token: 'x', relative_path: '' });
		}

		if (path === '/api/search') {
			if (!plugins.search) return notFound();
			const term = (url.searchParams.get('term') ?? '').toLowerCase();
			const matched = Object.values(TOPICS).filter(t =>
				`${t.title} ${t.posts.map(p => p.content).join(' ')}`.toLowerCase().includes(term.split(' ')[0] ?? ''));
			return json(200, {
				matchCount: matched.length,
				pageCount: 1,
				posts: matched.map((t) => {
					const topicField = { tid: t.tid, title: t.title, slug: t.slug, cid: t.cid };
					// filter:post.getPostSummaryByPids adds isSolved when Q&A is on.
					if (plugins.qna && t.isSolved !== undefined) topicField.isSolved = t.isSolved;
					return {
						pid: t.posts[0].pid,
						tid: t.tid,
						index: 0,
						timestamp: t.timestamp,
						content: t.posts[0].content,
						user: t.user,
						topic: topicField,
						category: t.category,
					};
				}),
			});
		}

		if (path === '/api/categories') {
			return json(200, {
				categories: [
					{ cid: 1, name: 'General', slug: '1/general', description: 'Anything', topic_count: 20, post_count: 90, children: [] },
					{ cid: 3, name: 'Support', slug: '3/support', description: 'Help &amp; questions', topic_count: 44, post_count: 310, children: [] },
				],
			});
		}

		if (path === '/api/recent' || path === '/api/popular' || path === '/api/top') {
			const page = Number(url.searchParams.get('page') ?? 1);
			const all = Object.values(TOPICS).map(t => summaryOf(t, { qna: plugins.qna }));
			return json(200, { topics: page === 1 ? all : [] });
		}

		if (path === '/api/unsolved') {
			if (!plugins.qna) return notFound();
			const unsolved = Object.values(TOPICS)
				.filter(t => t.isQuestion === 1 && t.isSolved !== 1)
				.map(t => summaryOf(t, { qna: true }));
			return json(200, { topics: unsolved });
		}

		if (path === '/api/solved') {
			if (!plugins.qna) return notFound();
			const solved = Object.values(TOPICS)
				.filter(t => t.isSolved === 1)
				.map(t => summaryOf(t, { qna: true }));
			return json(200, { topics: solved });
		}

		const topicMatch = path.match(/^\/api\/topic\/(\d+)/);
		if (topicMatch) {
			const topic = TOPICS[Number(topicMatch[1])];
			if (!topic) return json(404, { status: { code: 'not-found', message: '[[error:no-topic]]' } });
			return json(200, topicPayload(topic, { qna: plugins.qna }));
		}

		const catMatch = path.match(/^\/api\/category\/(\d+)/);
		if (catMatch) {
			const cid = Number(catMatch[1]);
			return json(200, {
				cid,
				topics: Object.values(TOPICS).filter(t => t.cid === cid).map(t => summaryOf(t, { qna: plugins.qna })),
			});
		}

		const v3TopicMatch = path.match(/^\/api\/v3\/topics\/(\d+)$/);
		if (v3TopicMatch) {
			const topic = TOPICS[Number(v3TopicMatch[1])];
			if (!topic) return v3(404, {});
			return v3(200, summaryOf(topic, { qna: plugins.qna }));
		}

		const v3PostMatch = path.match(/^\/api\/v3\/posts\/(\d+)$/);
		if (v3PostMatch) {
			const pid = Number(v3PostMatch[1]);
			for (const topic of Object.values(TOPICS)) {
				const post = topic.posts.find(p => p.pid === pid);
				if (post) return v3(200, { ...post, tid: topic.tid });
			}
			return v3(404, {});
		}

		const qnaMatch = path.match(/^\/api\/v3\/plugins\/qna\/(\d+)$/);
		if (qnaMatch) {
			if (!plugins.qna) return notFound();
			const topic = TOPICS[Number(qnaMatch[1])];
			if (!topic) return v3(404, {});
			return v3(200, { isQuestion: String(topic.isQuestion ?? 0), isSolved: String(topic.isSolved ?? 0) });
		}

		if (path === '/api/v3/plugins/shotef/ping') {
			if (!plugins.shotef) return notFound();
			return json(200, { ok: 1, uid: 1 });
		}

		const statusMatch = path.match(/^\/api\/v3\/plugins\/shotef\/public-status\/(\d+)$/);
		if (statusMatch) {
			if (!plugins.shotef) return notFound();
			const tid = Number(statusMatch[1]);
			if (tid === 10) {
				return v3(200, {
					tracked: true, status: 'closed', label: 'Closed', closeReason: 'resolved',
					updatedAt: 1_700_000_300_000, teamName: 'Core Support', parked: false,
					holdReason: null, isMember: false, team: null,
				});
			}
			if (tid === 11) {
				return v3(200, {
					tracked: true, status: 'in_progress', label: 'In progress',
					closeReason: '', updatedAt: 1_700_100_500_000, teamName: 'Core Support',
					parked: false, holdReason: null, isMember: false, team: null,
				});
			}
			return v3(200, { tracked: false });
		}

		if (path === '/api/v3/plugins/shotef/public-statuses') {
			if (!plugins.shotef) return notFound();
			const tids = (url.searchParams.get('tids') ?? '').split(',').map(Number).filter(Boolean);
			const statuses = {};
			for (const tid of tids) {
				if (tid === 10) statuses[10] = { tracked: true, status: 'closed', label: 'Closed', updatedAt: 1, parked: false };
				if (tid === 11) statuses[11] = { tracked: true, status: 'in_progress', label: 'In progress', updatedAt: 2, parked: false };
			}
			return v3(200, { statuses });
		}

		if (path === '/api/v3/plugins/shotef/board') {
			if (!plugins.shotef) return notFound();
			if (opts.shotefNonMember) return v3(403, {});
			return v3(200, {
				team: 'core',
				teams: [{ id: 'core', name: 'Core Support', selected: true }],
				columns: [
					{ key: 'todo', label: 'Todo', class: 'active', publicStatus: 'received' },
					{ key: 'in_work', label: 'In work', class: 'active', publicStatus: 'in_progress' },
				],
				topics: [
					{ tid: 11, title: 'Plugin symlink disappears after npm install', slug: '11/plugin-symlink-disappears', status: 'in_work', priority: 'high', claimedByUser: { username: 'maintainer' }, updatedAt: 1_700_100_500_000, helpWanted: true },
					{ tid: 13, title: 'Email digests not sending', slug: '13/email-digests', status: 'todo', priority: 'normal', updatedAt: 1_700_200_000_000 },
				],
			});
		}

		return notFound();
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();

	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		async close() {
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

export { TOPICS };
