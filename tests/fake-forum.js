/**
 * A fake NodeBB forum over real HTTP, modelled on NodeBB v4.16 with
 * nodebb-plugin-dbsearch, nodebb-plugin-question-and-answer and Shotef.
 *
 * Every quirk here was observed on a real forum by the e2e suite
 * (tests/e2e) — when the two disagree, the real forum wins and this file is
 * fixed. The ones that bite:
 *
 *  - Identity: /api/config reports the acting `uid`. A bearer token the forum
 *    does not recognise is NOT rejected — the request silently runs as a guest.
 *    A master token without `_uid` makes the Read API answer 500 and the Write
 *    API answer 400 with an explanation.
 *  - Guests lack the `search:content` privilege by default: /api/search → 401.
 *    With no search plugin at all, /api/search 404s and config.searchEnabled is
 *    false. config carries a `question-and-answer` key when Q&A is active.
 *  - v4 returns titles *raw* from every API surface (`&`, `<`, `"` unescaped);
 *    `escapeTitles` emulates older forums that sent them HTML-escaped.
 *  - Q&A keeps its state as topic-hash fields, which NodeBB serves on every
 *    topic read — even after the plugin is deactivated, when they are stale.
 *  - Q&A: when the accepted answer is not the first reply, the topic's posts
 *    contain a *duplicate* of it right after the opening post (allowDupe,
 *    navigatorIgnore). Search hits get topic.isQuestion/isSolved = null for
 *    non-questions. Accepting an answer is socket-only in Q&A itself.
 *  - dbsearch can return the same post twice; summaries carry no `index`.
 *  - /api/v3/posts/:pid is raw markdown with no `user`; /summary has both.
 *  - Shotef board: { team:{id,name}, columns:[{key,label,class,publicStatus,
 *    cards[]}], backlog:[…], intake:[…] }, or { noTeam:true } for a non-member.
 *    Ticket actions answer translated English errors with real status codes.
 *  - A guest write fails CSRF with a plain-text 403 "Forbidden".
 *  - Password sign-in: GET /api/config issues an `express.sid` cookie and a
 *    csrf_token; POST /api/v3/utilities/login needs both (else plain 403
 *    "Forbidden"), regenerates the session id and keeps the token. Refusals are
 *    text/html 403 bodies with raw keys (invalid-login-credentials, also for an
 *    unknown user; account-locked after 5 counted failures). A password shorter
 *    than 6 is refused *before* the attempt is counted. Cookie writes need
 *    `x-csrf-token`. Page payloads carry `loggedIn` / `loggedInUser`; an expired
 *    session is silently a guest.
 */

import { randomBytes } from 'node:crypto';
import http from 'node:http';

const USERS = {
	1: { uid: 1, username: 'admin', userslug: 'admin' },
	2: { uid: 2, username: 'member', userslug: 'member' },
	5: { uid: 5, username: 'reporter', userslug: 'reporter' },
	6: { uid: 6, username: 'dev', userslug: 'dev' },
	7: { uid: 7, username: 'helper', userslug: 'helper' },
	8: { uid: 8, username: 'maintainer', userslug: 'maintainer' },
	9: { uid: 9, username: 'outsider', userslug: 'outsider' },
};

/** Account passwords for the session tests (at least 6 characters, as NodeBB requires). */
export const PASSWORDS = {
	1: 'admin-pass-1',
	5: 'reporter-pass-1',
	8: 'maintainer-pass-1',
	9: 'outsider-pass-1',
};

export const TOKENS = {
	'admin-token': 1,
	'maintainer-token': 8,
	'outsider-token': 9,
	'master-token': 'master',
};

const MASTER_NO_UID = 'A master token was received without a corresponding `_uid` in the request body';

function seedTopics() {
	return {
		10: {
			tid: 10,
			title: 'Redis connection refused after upgrade & restart',
			slug: '10/redis-connection-refused',
			cid: 3,
			uid: 5,
			postcount: 4,
			viewcount: 240,
			timestamp: 1_700_000_000_000,
			tags: ['redis', 'upgrade'],
			isQuestion: 1,
			isSolved: 1,
			solvedPid: 102,
			posts: [
				{ pid: 100, index: 0, uid: 5, timestamp: 1_700_000_000_000, votes: 0, content: '<p>After upgrading, NodeBB won&#x27;t start. Log says <code>ECONNREFUSED 127.0.0.1:6379</code>.</p>' },
				{ pid: 101, index: 1, uid: 7, timestamp: 1_700_000_100_000, votes: 0, content: '<p>Is redis actually running?</p>' },
				{ pid: 102, index: 2, uid: 8, timestamp: 1_700_000_200_000, votes: 12, content: '<p>Start redis pointed at your data dir:</p><pre><code>redis-server --dir /var/lib/redis --appendonly yes</code></pre><p>Then restart NodeBB.</p>' },
				{ pid: 103, index: 3, uid: 5, timestamp: 1_700_000_300_000, votes: 0, content: '<p>That fixed it, thanks!</p>' },
			],
		},
		11: {
			tid: 11,
			title: 'Plugin symlink disappears after npm install',
			slug: '11/plugin-symlink-disappears',
			cid: 3,
			uid: 6,
			postcount: 1,
			viewcount: 12,
			timestamp: 1_700_100_000_000,
			tags: ['plugins'],
			isQuestion: 1,
			isSolved: 0,
			posts: [
				{ pid: 110, index: 0, uid: 6, timestamp: 1_700_100_000_000, votes: 0, content: '<p>My plugin 404s and the log says it is active but not installed.</p>' },
			],
		},
		12: {
			tid: 12,
			title: 'Welcome to the forum',
			slug: '12/welcome',
			cid: 1,
			uid: 1,
			postcount: 2,
			viewcount: 900,
			timestamp: 1_699_000_000_000,
			tags: [],
			posts: [
				{ pid: 120, index: 0, uid: 1, timestamp: 1_699_000_000_000, votes: 0, content: '<p>Hello!</p>' },
				{ pid: 121, index: 1, uid: 2, timestamp: 1_699_000_100_000, votes: 3, content: '<p>Glad to be here.</p>' },
			],
		},
	};
}

const COLUMNS = [
	{ key: 'todo', label: 'Todo', order: 1, class: 'active', publicStatus: 'received' },
	{ key: 'in_work', label: 'In work', order: 2, class: 'active', publicStatus: 'in_progress' },
	{ key: 'waiting', label: 'Waiting for Response', order: 3, class: 'active', publicStatus: 'in_progress' },
	{ key: 'responded', label: 'Responded', order: 4, class: 'backlog', publicStatus: 'answered' },
	{ key: 'closed', label: 'Closed', order: 5, class: 'terminal', publicStatus: 'closed' },
	{ key: 'blocked', label: 'Blocked', order: 6, class: 'backlog', publicStatus: 'in_progress' },
	{ key: 'deferred', label: 'Deferred', order: 7, class: 'backlog', publicStatus: 'received' },
	{ key: 'feature', label: 'Feature request', order: 8, class: 'backlog', publicStatus: 'received' },
];
const isParked = c => c.class === 'backlog' && c.publicStatus !== 'answered' && c.publicStatus !== 'closed';
const PUBLIC_LABELS = { received: 'Received', in_progress: 'In progress', answered: 'Awaiting your reply', closed: 'Closed' };

const TEAM = { id: 'core', name: 'Core Support', members: [1, 8], managers: [1], categories: [3] };

function seedTickets() {
	return {
		10: { tid: 10, status: 'closed', closeReason: 'resolved', priority: 'normal', claimedBy: 0, updatedAt: 1_700_000_300_000, createdAt: 1_700_000_000_000 },
		11: { tid: 11, status: 'in_work', priority: 'high', claimedBy: 8, helpWanted: true, updatedAt: 1_700_100_500_000, createdAt: 1_700_100_000_000 },
		13: { tid: 13, title: 'Email digests not sending', slug: '13/email-digests', status: 'todo', priority: 'normal', claimedBy: 0, updatedAt: 1_700_200_000_000, createdAt: 1_700_200_000_000 },
		14: { tid: 14, title: 'Avatar upload fails', slug: '14/avatar-upload', status: 'blocked', priority: 'low', claimedBy: 0, updatedAt: 1_700_300_000_000, createdAt: 1_700_300_000_000 },
	};
}

/**
 * Start a fake forum.
 *
 * @param {object} opts
 * @param {{search?:boolean,qna?:boolean,shotef?:boolean}} [opts.plugins]
 * @param {boolean} [opts.guestSearch] grant guests search:content (off, as in NodeBB)
 * @param {boolean} [opts.escapeTitles] emulate a forum that sends titles HTML-escaped
 * @param {boolean} [opts.shotefIgnoresTokens] emulate Shotef < the setupApiRoute fix
 * @param {boolean} [opts.loginWithoutSession] password accepted but no session granted (e.g. 2FA pending)
 */
export async function startFakeForum(opts = {}) {
	const plugins = { search: true, qna: true, shotef: true, ...(opts.plugins ?? {}) };
	const TOPICS = seedTopics();
	const tickets = seedTickets();
	const notes = {};
	const timeline = {};
	let nextTid = 50;
	let nextPid = 500;
	/** sid -> { uid, csrf } */
	const sessions = new Map();
	/** Every counted login attempt, in order: { username, ok } */
	const loginAttempts = [];
	const failures = {};
	const locked = new Set();
	const newSid = () => randomBytes(12).toString('hex');
	/** @type {{method:string,path:string,query:object,auth:string|undefined,body:any,uid:number}[]} */
	const requests = [];

	const esc = s => (opts.escapeTitles
		? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
		: s);

	const userOf = uid => USERS[uid] ?? { uid, username: `user${uid}`, userslug: `user${uid}` };
	const category = cid => ({ cid, name: cid === 3 ? 'Support & Help' : 'General' });
	const allPosts = () => Object.values(TOPICS).flatMap(t => t.posts.map(p => ({ ...p, tid: t.tid })));

	function summaryOf(topic) {
		const base = {
			tid: topic.tid,
			title: esc(topic.title),
			slug: topic.slug,
			cid: topic.cid,
			category: category(topic.cid),
			uid: topic.uid,
			user: userOf(topic.uid),
			postcount: topic.postcount,
			viewcount: topic.viewcount,
			timestamp: topic.timestamp,
			tags: topic.tags.map(value => ({ value, valueEncoded: value, class: value })),
		};
		// Topic hash fields ride along on every topic read — Q&A writes them as
		// strings, and they stay after the plugin is deactivated (stale state).
		if (topic.isQuestion !== undefined) {
			base.isQuestion = String(topic.isQuestion);
			base.isSolved = String(topic.isSolved);
			if (topic.solvedPid) base.solvedPid = String(topic.solvedPid);
		}
		return base;
	}

	function topicPayload(topic) {
		const payload = { ...summaryOf(topic), mainPid: topic.posts[0].pid };
		let posts = topic.posts.map(p => ({ ...p, tid: topic.tid, user: userOf(p.uid), upvotes: Math.max(0, p.votes) }));
		if (plugins.qna && topic.solvedPid) {
			// filter:topic.getPosts: copy the answer in after the OP when it is not the first reply.
			const answer = posts.find(p => p.pid === topic.solvedPid);
			if (answer && posts[1]?.pid !== topic.solvedPid) {
				posts.splice(1, 0, { ...answer, allowDupe: true, navigatorIgnore: true, eventStart: 0, eventEnd: 0 });
			}
			posts = posts.map(p => ({ ...p, isAnswer: p.pid === topic.solvedPid }));
		}
		payload.posts = posts;
		return payload;
	}

	function boardCard(ticket) {
		const topic = TOPICS[ticket.tid];
		const card = {
			tid: ticket.tid,
			title: topic?.title ?? ticket.title,
			slug: topic?.slug ?? ticket.slug,
			cid: 3,
			catName: 'Support & Help',
			tags: topic?.tags ?? [],
			priority: ticket.priority || 'normal',
			helpWanted: Boolean(ticket.helpWanted),
			status: ticket.status,
			closeReason: ticket.closeReason || '',
			createdAt: ticket.createdAt,
			updatedAt: ticket.updatedAt,
			idleDays: 3,
			openDays: 5,
			claimedByUid: ticket.claimedBy || 0,
			claimedBy: ticket.claimedBy ? { uid: ticket.claimedBy, username: userOf(ticket.claimedBy).username } : null,
		};
		if (plugins.qna && topic && Number(topic.isQuestion)) {
			card.isQuestion = true;
			card.isSolved = Boolean(Number(topic.isSolved));
		}
		return card;
	}

	function publicStatus(ticket, uid) {
		const col = COLUMNS.find(c => c.key === ticket.status);
		const key = col.publicStatus;
		const isMember = TEAM.members.includes(uid);
		const parked = isParked(col);
		return {
			tracked: true,
			status: key,
			label: PUBLIC_LABELS[key],
			closeReason: key === 'closed' ? (ticket.closeReason || 'resolved') : '',
			updatedAt: ticket.updatedAt,
			teamName: TEAM.name,
			parked,
			holdReason: isMember && parked ? col.label : null,
			isMember,
			team: isMember ? TEAM.id : null,
		};
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		const path = url.pathname;
		const method = req.method;
		let raw = '';
		for await (const chunk of req) raw += chunk;
		let body = {};
		try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

		const json = (status, payload) => {
			res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify(payload));
		};
		const v3 = (status, payload, message) => json(status, {
			status: { code: status === 200 ? 'ok' : status === 403 ? 'forbidden' : status === 404 ? 'not-found' : 'bad-request', message: message ?? (status === 200 ? 'OK' : 'Error') },
			response: payload ?? {},
		});
		const notFound = () => {
			if (path.startsWith('/api/v3')) return v3(404, {}, 'Invalid API call');
			res.writeHead(404, { 'content-type': 'text/html' });
			res.end('<html>404</html>');
		};

		// --- authentication, as middleware/user.js does it ---------------------
		const header = req.headers.authorization ?? '';
		const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
		let uid = 0;
		if (token && token in TOKENS) {
			if (TOKENS[token] === 'master') {
				const asUid = url.searchParams.get('_uid') ?? body._uid;
				if (asUid === undefined || asUid === null) {
					requests.push({ method, path, query: Object.fromEntries(url.searchParams), auth: header, body, uid: 0 });
					if (path.startsWith('/api/v3')) return v3(400, {}, MASTER_NO_UID);
					return json(500, { error: '[[error:api.master-token-no-uid]]' });
				}
				uid = Number(asUid);
			} else {
				uid = TOKENS[token];
			}
		}
		// An unrecognised token falls through as a guest — NodeBB does not reject it.
		const viaToken = Boolean(token && token in TOKENS);

		// Cookie session (express-session); an unknown or expired sid is a guest.
		const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';')
			.map(part => part.trim()).filter(Boolean)
			.map((part) => { const at = part.indexOf('='); return [part.slice(0, at), part.slice(at + 1)]; }));
		const sid = cookies['express.sid'];
		let session = sid ? sessions.get(sid) : undefined;
		if (!viaToken && session) uid = session.uid;

		requests.push({
			method, path, query: Object.fromEntries(url.searchParams), auth: header || undefined, body, uid,
			cookie: Boolean(sid), csrf: req.headers['x-csrf-token'],
		});

		const isWrite = method !== 'GET';
		if (isWrite && path.startsWith('/api/v3') && !viaToken) {
			// Cookie (or no) auth: csrf-sync wants the session's token, before any route runs.
			if (!session || req.headers['x-csrf-token'] !== session.csrf) {
				res.writeHead(403, { 'content-type': 'text/plain' });
				return res.end('Forbidden');
			}
		}

		/** A page payload: NodeBB adds who it was rendered for. */
		const page = payload => json(200, { ...payload, loggedIn: uid > 0, loggedInUser: uid > 0 ? userOf(uid) : { uid: 0 } });

		if (path === '/api/v3/utilities/login' && method === 'POST') {
			const html = (status, text) => {
				res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
				res.end(text);
			};
			const name = String(body.username ?? '');
			const password = String(body.password ?? '');
			// NodeBB rejects a too-short password before it counts the attempt.
			if (password.length < 6) return html(403, '[[error:invalid-login-credentials]]');
			const account = Object.values(USERS).find(u => u.username === name);
			const key = account ? account.uid : 'dummy';
			if (locked.has(key)) return html(403, '[[error:account-locked]]');
			failures[key] = (failures[key] ?? 0) + 1;
			if (failures[key] > 5) {
				locked.add(key);
				loginAttempts.push({ username: name, ok: false });
				return html(403, '[[error:account-locked]]');
			}
			const ok = Boolean(account) && PASSWORDS[account.uid] === password;
			loginAttempts.push({ username: name, ok });
			if (!ok) return html(403, '[[error:invalid-login-credentials]]');
			failures[key] = 0;
			if (!opts.loginWithoutSession) {
				// Login regenerates the session id and keeps the CSRF token.
				sessions.delete(sid);
				const fresh = newSid();
				sessions.set(fresh, { uid: account.uid, csrf: session.csrf });
				res.setHeader('set-cookie', `express.sid=${fresh}; Path=/; HttpOnly; SameSite=Lax`);
			}
			return v3(200, { ...userOf(account.uid), 'email:confirmed': 0 });
		}

		if (path === '/api/config') {
			if (!viaToken && !session) {
				const fresh = newSid();
				session = { uid: 0, csrf: randomBytes(16).toString('hex') };
				sessions.set(fresh, session);
				res.setHeader('set-cookie', `express.sid=${fresh}; Path=/; Expires=${new Date(Date.now() + 864e5).toUTCString()}; HttpOnly; SameSite=Lax`);
			}
			const config = {
				siteTitle: 'Fake Forum', relative_path: '', uid, loggedIn: uid > 0, searchEnabled: plugins.search,
				csrf_token: session?.csrf ?? 'x',
			};
			if (plugins.qna) config['question-and-answer'] = { forceQuestions: 'off' };
			return json(200, config);
		}
		if (path === '/api/v3/ping') return v3(200, { pong: true });

		const userMatch = path.match(/^\/api\/v3\/users\/(\d+)$/);
		if (userMatch) return v3(200, userOf(Number(userMatch[1])));

		if (path === '/api/search') {
			if (!plugins.search) return notFound();
			if (uid === 0 && !opts.guestSearch) {
				return v3(401, {}, 'A valid login session was not found. Please log in and try again.');
			}
			const term = (url.searchParams.get('term') ?? '').toLowerCase();
			const words = term.split(/\s+/).filter(Boolean);
			const matched = Object.values(TOPICS).filter(t =>
				words.some(w => `${t.title} ${t.posts.map(p => p.content).join(' ')}`.toLowerCase().includes(w)));
			const hits = matched.map((t) => {
				const topicField = { tid: t.tid, title: esc(t.title), slug: t.slug, cid: t.cid };
				// filter:post.getPostSummaryByPids: parseInt of the topic field, null for non-questions.
				if (plugins.qna) {
					topicField.isQuestion = t.isQuestion === undefined ? null : Number(t.isQuestion);
					topicField.isSolved = t.isSolved === undefined ? null : Number(t.isSolved);
				}
				return {
					pid: t.posts[0].pid,
					tid: t.tid,
					timestamp: t.timestamp,
					content: t.posts[0].content,
					user: userOf(t.uid),
					topic: topicField,
					category: category(t.cid),
				};
			});
			// dbsearch returns a post twice when it matches in title and body.
			const posts = hits.length ? [...hits, hits[0]] : hits;
			return json(200, { matchCount: posts.length, pageCount: 1, posts });
		}

		if (path === '/api/categories') {
			return page({
				categories: [
					{ cid: 1, name: 'General', slug: '1/general', description: 'Anything', descriptionParsed: '<p>Anything</p>', topic_count: 20, post_count: 90, children: [] },
					{ cid: 3, name: 'Support & Help', slug: '3/support', description: 'Help & questions', descriptionParsed: '<p>Help &amp; questions</p>', topic_count: 44, post_count: 310, children: [] },
				],
			});
		}

		if (path === '/api/recent' || path === '/api/popular' || path === '/api/top') {
			const pageNo = Number(url.searchParams.get('page') ?? 1);
			return page({ topics: pageNo === 1 ? Object.values(TOPICS).map(summaryOf) : [] });
		}

		if (path === '/api/unsolved' || path === '/api/solved') {
			if (!plugins.qna) return notFound();
			const wantSolved = path === '/api/solved';
			const list = Object.values(TOPICS)
				.filter(t => Number(t.isQuestion) === 1 && (Number(t.isSolved) === 1) === wantSolved)
				.map(summaryOf);
			return page({ topics: list });
		}

		const topicMatch = path.match(/^\/api\/topic\/(\d+)/);
		if (topicMatch) {
			const topic = TOPICS[Number(topicMatch[1])];
			if (!topic) return json(404, { status: { code: 'not-found', message: '[[error:no-topic]]' } });
			return page(topicPayload(topic));
		}

		const catMatch = path.match(/^\/api\/category\/(\d+)/);
		if (catMatch) {
			const cid = Number(catMatch[1]);
			return page({ cid, topics: Object.values(TOPICS).filter(t => t.cid === cid).map(summaryOf) });
		}

		// --- core Write API ----------------------------------------------------
		if (path === '/api/v3/topics' && method === 'POST') {
			const tid = nextTid++;
			const pid = nextPid++;
			const title = String(body.title ?? '');
			const topic = {
				tid, title, slug: `${tid}/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, cid: Number(body.cid), uid,
				postcount: 1, viewcount: 0, timestamp: Date.now(), tags: body.tags ?? [],
				posts: [{ pid, index: 0, uid, timestamp: Date.now(), votes: 0, content: `<p>${body.content}</p>` }],
			};
			if (plugins.qna && 'isQuestion' in body) Object.assign(topic, { isQuestion: 1, isSolved: 0 });
			TOPICS[tid] = topic;
			if (plugins.shotef && TEAM.categories.includes(topic.cid)) {
				tickets[tid] = { tid, status: 'todo', priority: 'normal', claimedBy: 0, createdAt: Date.now(), updatedAt: Date.now() };
			}
			return v3(200, { ...summaryOf(topic), mainPid: pid });
		}

		const replyMatch = path.match(/^\/api\/v3\/topics\/(\d+)$/);
		if (replyMatch && method === 'POST') {
			const topic = TOPICS[Number(replyMatch[1])];
			if (!topic) return v3(404, {}, 'Invalid topic');
			const pid = nextPid++;
			topic.posts.push({ pid, index: topic.posts.length, uid, timestamp: Date.now(), votes: 0, content: `<p>${body.content}</p>` });
			topic.postcount += 1;
			// Shotef's ball-in-court: a team member's reply hands the ball to the reporter.
			const ticket = tickets[topic.tid];
			if (plugins.shotef && ticket && TEAM.members.includes(uid) && ticket.status !== 'closed') {
				ticket.status = 'responded';
				ticket.updatedAt = Date.now();
			}
			return v3(200, { pid, tid: topic.tid, index: topic.posts.length - 1, user: userOf(uid) });
		}

		const voteMatch = path.match(/^\/api\/v3\/posts\/(\d+)\/vote$/);
		if (voteMatch) {
			const pid = Number(voteMatch[1]);
			const post = Object.values(TOPICS).flatMap(t => t.posts).find(p => p.pid === pid);
			if (!post) return v3(404, {}, 'Invalid post');
			if (post.uid === uid) return v3(400, {}, 'You cannot vote on your own post');
			post.voters = post.voters ?? {};
			const prior = post.voters[uid] ?? 0;
			const next = method === 'DELETE' ? 0 : Math.sign(Number(body.delta));
			post.votes += next - prior;
			post.voters[uid] = next;
			return v3(200, {});
		}

		const v3PostMatch = path.match(/^\/api\/v3\/posts\/(\d+)(\/summary)?$/);
		if (v3PostMatch) {
			const pid = Number(v3PostMatch[1]);
			const found = allPosts().find(p => p.pid === pid);
			if (!found) return v3(404, {}, 'Invalid post');
			const topic = TOPICS[found.tid];
			if (method === 'PUT') {
				topic.posts.find(p => p.pid === pid).content = `<p>${body.content}</p>`;
				if (body.title && found.index === 0) topic.title = body.title;
				return v3(200, { pid, tid: topic.tid, content: body.content, user: userOf(found.uid) });
			}
			if (v3PostMatch[2]) {
				const topicField = { tid: topic.tid, title: esc(topic.title), slug: topic.slug, cid: topic.cid };
				if (plugins.qna) {
					topicField.isQuestion = topic.isQuestion === undefined ? null : Number(topic.isQuestion);
					topicField.isSolved = topic.isSolved === undefined ? null : Number(topic.isSolved);
				}
				return v3(200, { ...found, user: userOf(found.uid), topic: topicField, category: category(topic.cid), isMainPost: found.index === 0 });
			}
			// The plain route: raw markdown, no user object, no index.
			const { index, ...rest } = found;
			return v3(200, { ...rest, content: rest.content.replace(/<[^>]+>/g, '') });
		}

		const v3TopicMatch = path.match(/^\/api\/v3\/topics\/(\d+)$/);
		if (v3TopicMatch) {
			const topic = TOPICS[Number(v3TopicMatch[1])];
			if (!topic) return v3(404, {}, 'Invalid topic');
			return v3(200, summaryOf(topic));
		}

		const qnaMatch = path.match(/^\/api\/v3\/plugins\/qna\/(\d+)$/);
		if (qnaMatch) {
			if (!plugins.qna) return notFound();
			const topic = TOPICS[Number(qnaMatch[1])];
			if (!topic) return v3(404, {});
			return v3(200, { isQuestion: String(topic.isQuestion ?? 0), isSolved: String(topic.isSolved ?? 0) });
		}

		// --- Shotef -------------------------------------------------------------
		if (path.startsWith('/api/v3/plugins/shotef/') && !plugins.shotef) return notFound();
		const shotefUid = opts.shotefIgnoresTokens ? 0 : uid;
		const member = TEAM.members.includes(shotefUid);

		if (path === '/api/v3/plugins/shotef/ping') return json(200, { ok: 1, uid: shotefUid });

		const statusMatch = path.match(/^\/api\/v3\/plugins\/shotef\/public-status\/(\d+)$/);
		if (statusMatch) {
			const ticket = tickets[Number(statusMatch[1])];
			return v3(200, ticket ? publicStatus(ticket, shotefUid) : { tracked: false });
		}

		if (path === '/api/v3/plugins/shotef/public-statuses') {
			const tids = (url.searchParams.get('tids') ?? '').split(',').map(Number).filter(Boolean);
			const statuses = {};
			for (const tid of tids) {
				if (!tickets[tid]) continue;
				const full = publicStatus(tickets[tid], shotefUid);
				statuses[tid] = { tracked: true, status: full.status, label: full.label, updatedAt: full.updatedAt, parked: full.parked };
			}
			return v3(200, { statuses });
		}

		if (path === '/api/v3/plugins/shotef/board') {
			if (!member) return v3(200, { noTeam: true, teams: [] });
			const build = c => ({
				key: c.key, label: c.label, class: c.class, publicStatus: c.publicStatus,
				cards: Object.values(tickets).filter(t => t.status === c.key).map(boardCard),
			});
			const columns = COLUMNS.filter(c => !isParked(c)).map(build).map(c => ({ ...c, count: c.cards.length }));
			const backlog = COLUMNS.filter(isParked).map(build).map(c => ({ ...c, count: c.cards.length }));
			return v3(200, {
				teams: [{ id: TEAM.id, name: TEAM.name, selected: true }],
				me: { uid: shotefUid, username: userOf(shotefUid).username },
				team: { id: TEAM.id, name: TEAM.name },
				columns,
				backlog,
				backlogCount: backlog.reduce((n, c) => n + c.count, 0),
				intake: [],
				intakeCount: 0,
				shotef: { uid: 8, username: 'maintainer' },
				vacant: false,
				isManager: TEAM.managers.includes(shotefUid),
			});
		}

		const ticketMatch = path.match(/^\/api\/v3\/plugins\/shotef\/tickets\/(\d+)(\/[a-z-]+)?$/);
		if (ticketMatch) {
			const tid = Number(ticketMatch[1]);
			const action = ticketMatch[2] ?? '';
			const ticket = tickets[tid];
			if (!ticket) return v3(404, {}, 'This topic is not tracked by Shotef');
			if (shotefUid === 0) return v3(401, {}, 'You must be logged in');
			if (!member) return v3(403, {}, 'You are not a member of this team');
			const audit = (entry) => { (timeline[tid] = timeline[tid] ?? []).push({ ts: Date.now(), actor: userOf(shotefUid).username, ...entry }); };
			const topic = TOPICS[tid];

			if (method === 'GET' && action === '') {
				const qna = plugins.qna && topic && Number(topic.isQuestion);
				return v3(200, {
					tid,
					title: topic?.title ?? ticket.title,
					slug: topic?.slug ?? ticket.slug,
					cid: 3,
					category: 'Support & Help',
					handlingTeam: TEAM.id,
					handlingTeamName: TEAM.name,
					readOnly: false,
					status: ticket.status,
					publicStatus: COLUMNS.find(c => c.key === ticket.status).publicStatus,
					closeReason: ticket.closeReason || '',
					priority: ticket.priority,
					helpWanted: Boolean(ticket.helpWanted),
					isQuestion: Boolean(qna),
					isSolved: qna ? Boolean(Number(topic.isSolved)) : false,
					createdAt: ticket.createdAt,
					updatedAt: ticket.updatedAt,
					claimedBy: ticket.claimedBy ? { uid: ticket.claimedBy, username: userOf(ticket.claimedBy).username } : null,
					timeline: timeline[tid] ?? [],
					notes: notes[tid] ?? [],
				});
			}
			if (action === '/status' && method === 'PUT') {
				const to = body.status ?? body.to;
				const col = COLUMNS.find(c => c.key === to);
				if (!col) return v3(400, {}, 'Unknown status');
				const closingResolved = col.class === 'terminal' && body.closeReason !== 'no_response';
				if (closingResolved && plugins.qna && topic && Number(topic.isQuestion) && !Number(topic.isSolved)) {
					return v3(409, {}, 'Mark this question as solved before closing it');
				}
				audit({ action: 'status_change', from: ticket.status, to, note: body.note });
				Object.assign(ticket, {
					status: to,
					closeReason: col.class === 'terminal' ? (body.closeReason || 'resolved') : '',
					updatedAt: Date.now(),
					...(col.class === 'backlog' ? { claimedBy: 0 } : {}),
				});
				return v3(200, { ...ticket });
			}
			if (action === '/claim') {
				ticket.claimedBy = method === 'DELETE' ? 0 : shotefUid;
				audit({ action: 'claim', to: method === 'DELETE' ? '' : String(shotefUid), toUsername: method === 'DELETE' ? null : userOf(shotefUid).username });
				return v3(200, { ...ticket });
			}
			if (action === '/assignee' && method === 'PUT') {
				if (!TEAM.managers.includes(shotefUid)) return v3(403, {}, 'Only a team manager can do that');
				const target = Number(body.uid ?? body.targetUid);
				if (!TEAM.members.includes(target)) return v3(400, {}, 'That user is not a member of this team');
				ticket.claimedBy = target;
				audit({ action: 'assign', to: String(target), toUsername: userOf(target).username });
				return v3(200, { ...ticket });
			}
			if (action === '/priority' && method === 'PUT') {
				const level = body.priority ?? body.level;
				if (!['low', 'normal', 'high', 'urgent'].includes(level)) return v3(400, {}, 'Invalid priority');
				audit({ action: 'priority', from: ticket.priority, to: level });
				ticket.priority = level;
				return v3(200, { ...ticket });
			}
			if (action === '/help-wanted' && method === 'PUT') {
				ticket.helpWanted = Boolean(body.on);
				return v3(200, { ...ticket });
			}
			if (action === '/notes' && method === 'POST') {
				if (!String(body.body ?? '').trim()) return v3(400, {}, 'Note is empty');
				const note = { ts: Date.now(), author: userOf(shotefUid).username, body: String(body.body) };
				(notes[tid] = notes[tid] ?? []).push(note);
				return v3(200, { ...note, teamId: TEAM.id });
			}
			if (action === '/solved' && method === 'PUT') {
				if (!plugins.qna) return json(501, { status: { code: 'error', message: "The Q&A plugin isn't active" }, response: {} });
				if (!topic || !Number(topic.isQuestion)) return v3(400, {}, "This topic isn't a Q&A question");
				const pid = Number(body.pid) || 0;
				if (pid && !topic.posts.some(p => p.pid === pid)) return v3(400, {}, "That reply doesn't belong to this ticket");
				Object.assign(topic, { isSolved: 1, solvedPid: pid || 0 });
				audit({ action: 'qa_solved', to: pid ? String(pid) : '' });
				return v3(200, { isSolved: true });
			}
			if (action === '/pass' && method === 'POST') {
				if ((body.toTeamId ?? body.team) === TEAM.id) return v3(400, {}, 'That ticket is already handled by this team');
				return v3(404, {}, 'No such team');
			}
			return notFound();
		}

		return notFound();
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();

	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		topics: TOPICS,
		tickets,
		notes,
		loginAttempts,
		/** Expire every session, as a server-side TTL or a revocation would. */
		expireSessions() { sessions.clear(); },
		lockAccount(uid) { locked.add(uid); },
		async close() {
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
