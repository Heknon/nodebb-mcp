#!/usr/bin/env node
/**
 * Seed a running NodeBB forum with the deterministic fixture the e2e suite
 * asserts against, then write e2e/.fixture.json (ids + tokens) for the tests.
 *
 *   NODEBB_URL=http://127.0.0.1:4567 NODEBB_DIR=/home/user/NodeBB node e2e/seed.mjs [--fresh]
 *
 * Everything goes through the *live* server's Write API, acting as each user
 * with a master token + `_uid`. That matters: plugins react to hooks that only
 * fire inside the server process — dbsearch indexes on action:post.save, Q&A
 * tags questions on filter:topic.create, Shotef tracks tickets on
 * action:topic.save — and the server's caches stay coherent, so no restart is
 * needed afterwards. (A standalone db script would bypass all of that.)
 *
 * Triage state and the accepted answer go through Shotef's HTTP ticket routes,
 * so seeding is itself a first exercise of that write surface.
 *
 * Idempotent: if the fixture file exists and its topics are still on the forum
 * it is reused. --fresh purges the fixture categories and team and rebuilds.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = process.env.E2E_FIXTURE || join(HERE, '.fixture.json');
const URL_BASE = (process.env.NODEBB_URL || 'http://127.0.0.1:4567').replace(/\/+$/, '');
const NODEBB_DIR = process.env.NODEBB_DIR || '/home/user/NodeBB';
const FRESH = process.argv.includes('--fresh');
const PASSWORD = 'E2e-pass-1234!';
const TEAM_ID = 'e2e-support';

const log = (...args) => process.stderr.write(`[seed] ${args.join(' ')}\n`);

function mintTokens(uids) {
	const out = execFileSync(process.execPath, [join(HERE, 'mint-tokens.cjs'), ...uids.map(String)], {
		env: { ...process.env, NODEBB_DIR },
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
	});
	return JSON.parse(out.trim().split('\n').pop());
}

let MASTER;

/** Call the forum as `uid` (master token + _uid). Returns the unwrapped response. */
async function call(uid, method, path, body) {
	const url = new URL(`${URL_BASE}${path}`);
	url.searchParams.set('_uid', String(uid));
	const res = await fetch(url, {
		method,
		headers: {
			authorization: `Bearer ${MASTER}`,
			accept: 'application/json',
			...(body !== undefined ? { 'content-type': 'application/json' } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json;
	try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 200) }; }
	if (!res.ok) {
		const message = json?.status?.message || json?.error || json?.raw || res.statusText;
		const err = new Error(`${method} ${path} as uid ${uid} -> HTTP ${res.status}: ${message}`);
		err.status = res.status;
		throw err;
	}
	return json && 'response' in json && 'status' in json ? json.response : json;
}

const admin = 1;

async function setting(key, value) {
	await call(admin, 'PUT', `/api/v3/admin/settings/${key}`, { value });
}

async function ensureUser(username) {
	try {
		const existing = await call(admin, 'GET', `/api/user/username/${encodeURIComponent(username)}`);
		if (existing?.uid) return Number(existing.uid);
	} catch (err) {
		if (err.status !== 404) throw err;
	}
	const created = await call(admin, 'POST', '/api/v3/users', { username, password: PASSWORD });
	return Number(created.uid);
}

async function createCategory(name, description) {
	const created = await call(admin, 'POST', '/api/v3/categories', { name, description });
	return Number(created.cid);
}

/** Make a category admin-only: rescind the read privileges every default group has. */
async function makePrivate(cid) {
	for (const member of ['guests', 'spiders', 'registered-users', 'fediverse']) {
		for (const privilege of ['groups:find', 'groups:read', 'groups:topics:read', 'groups:topics:create', 'groups:topics:reply']) {
			try {
				// eslint-disable-next-line no-await-in-loop
				await call(admin, 'DELETE', `/api/v3/categories/${cid}/privileges/${privilege}`, { member });
			} catch (err) {
				// A group that does not exist on this NodeBB version (fediverse) is fine.
				if (!/no-user-or-group|does not exist/i.test(err.message)) throw err;
			}
		}
	}
}

async function post(uid, cid, title, content, extra = {}) {
	const data = await call(uid, 'POST', '/api/v3/topics', { cid, title, content, ...extra });
	return { tid: Number(data.tid), mainPid: Number(data.mainPid), slug: data.slug };
}

async function reply(uid, tid, content) {
	const data = await call(uid, 'POST', `/api/v3/topics/${tid}`, { content });
	return Number(data.pid);
}

async function upvote(uid, pid) {
	await call(uid, 'PUT', `/api/v3/posts/${pid}/vote`, { delta: 1 });
}

const ticket = (tid, rest = '') => `/api/v3/plugins/shotef/tickets/${tid}${rest}`;

async function readFixture() {
	if (!existsSync(FIXTURE_FILE)) return undefined;
	try {
		const fixture = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8'));
		if (fixture.url !== URL_BASE) return undefined;
		MASTER = fixture.tokens.master;
		// Spot-check that the forum still holds what the file describes.
		for (const topic of Object.values(fixture.topics)) {
			// eslint-disable-next-line no-await-in-loop
			const data = await call(admin, 'GET', `/api/topic/${topic.tid}`);
			if (Number(data.tid) !== topic.tid) return undefined;
		}
		return fixture;
	} catch {
		return undefined;
	}
}

async function purge(fixture) {
	if (!fixture) return;
	log('purging previous fixture');
	for (const cid of Object.values(fixture.cids)) {
		// eslint-disable-next-line no-await-in-loop
		await call(admin, 'DELETE', `/api/v3/categories/${cid}`).catch(err => log(`  (cid ${cid}: ${err.message})`));
	}
	await call(admin, 'DELETE', `/api/v3/plugins/shotef/teams/${TEAM_ID}`).catch(() => {});
}

/**
 * Forum state every run needs, applied even when the fixture is reused:
 *  - settings that would otherwise stall scripted posting and voting;
 *  - a high per-IP login limit. NodeBB locks an IP after `ipLoginAttempts` (20)
 *    logins an hour — successful ones included — and every e2e run signs in a
 *    few times from 127.0.0.1. Test forum only: production keeps the default;
 *  - `e2e_wrongpass`, the account the wrong-password test fails against, so no
 *    fixture user is ever pushed toward NodeBB's account lockout.
 */
async function ensureBaseline() {
	for (const [key, value] of [
		['postQueue', 0], ['postDelay', 0], ['initialPostDelay', 0], ['newbiePostDelay', 0],
		['newbieReputationThreshold', 0], ['groupsExemptFromPostQueue', '["registered-users"]'],
		['ipLoginAttempts', 10000],
		// The write suite has the same reporter upvote the same answerer every run;
		// NodeBB allows 6 upvotes per user per day (20 in total) by default.
		['upvotesPerDay', 10000], ['upvotesPerUserPerDay', 10000],
		['downvotesPerDay', 10000], ['downvotesPerUserPerDay', 10000],
	]) {
		// eslint-disable-next-line no-await-in-loop
		await setting(key, value).catch(err => log(`  (setting ${key}: ${err.message})`));
	}
	await ensureUser('e2e_wrongpass');
}

async function seed() {
	// --- users --------------------------------------------------------------
	const uids = { admin };
	for (const name of ['e2e_reporter', 'e2e_helper', 'e2e_maintainer', 'e2e_outsider']) {
		// eslint-disable-next-line no-await-in-loop
		uids[name.replace('e2e_', '')] = await ensureUser(name);
	}
	log('users', JSON.stringify(uids));

	// --- categories ---------------------------------------------------------
	const cids = {
		support: await createCategory('E2E Support & Help', 'Questions & problem reports (triaged)'),
		general: await createCategory('E2E General Discussion', 'Anything else'),
		staff: await createCategory('E2E Staff Only', 'Private to administrators'),
	};
	await makePrivate(cids.staff);
	log('categories', JSON.stringify(cids));

	// --- triage team owns the support category (before topics, so the live
	//     action:topic.save hook tracks them exactly as it would in production) --
	await call(admin, 'PUT', `/api/v3/plugins/shotef/teams/${TEAM_ID}`, {
		name: 'Support & Ops',
		members: [admin, uids.helper, uids.maintainer].join(','),
		managers: String(admin),
		roster: [admin, uids.maintainer].join(','),
		categories: String(cids.support),
	});

	// --- topics -------------------------------------------------------------
	const topics = {};

	// A solved question whose accepted answer is NOT the first reply. That is the
	// case where the Q&A plugin inserts a duplicate of the answer into the post
	// list, which a reader must not show twice.
	topics.redis = await post(
		uids.reporter, cids.support,
		'Redis connection refused after upgrade & restart',
		'After upgrading to the new release, NodeBB won\'t start. The log says:\n\n' +
			'```\nError: connect ECONNREFUSED 127.0.0.1:6379\n```\n\nI didn\'t change any config.',
		{ tags: ['redis', 'upgrade'], isQuestion: 1 },
	);
	topics.redis.helperPid = await reply(uids.helper, topics.redis.tid,
		'Is Redis actually running? Check with `redis-cli ping` first.');
	topics.redis.answerPid = await reply(uids.maintainer, topics.redis.tid,
		'The upgrade reset the service unit, so Redis now starts without its data directory. ' +
			'Start it pointed at the existing data:\n\n```\nredis-server --dir /var/lib/redis --appendonly yes\n```\n\n' +
			'Then restart NodeBB with `./nodebb restart`.');
	topics.redis.thanksPid = await reply(uids.reporter, topics.redis.tid, 'That fixed it — thank you!');
	await upvote(uids.reporter, topics.redis.answerPid);
	await upvote(uids.helper, topics.redis.answerPid);

	// An open question nobody has answered.
	topics.symlink = await post(
		uids.reporter, cids.support,
		'Plugin symlink disappears after npm install',
		'My plugin route returns 404 and the log says the plugin is active but not installed. ' +
			'It started after I ran npm install for an unrelated package.',
		{ tags: ['plugins'], isQuestion: 1 },
	);

	// An open question with replies but no accepted answer.
	topics.images = await post(
		uids.reporter, cids.support,
		'Can\'t see uploaded images in posts',
		'Images I upload show as broken links, although the upload itself succeeds.',
		{ tags: ['uploads'], isQuestion: 1 },
	);
	topics.images.tipPid = await reply(uids.helper, topics.images.tid,
		'Check that upload_url in config.json matches the path your reverse proxy serves.');
	topics.images.metooPid = await reply(uids.outsider, topics.images.tid, 'Same problem here on 4.x.');
	await upvote(uids.outsider, topics.images.tipPid);

	// A plain discussion (not a Q&A question) with an upvoted reply.
	topics.digest = await post(
		uids.outsider, cids.support,
		'Email digest not sending',
		'Members say the weekly digest never arrives. Nothing in the logs.',
		{ tags: ['email'] },
	);
	topics.digest.answerPid = await reply(uids.helper, topics.digest.tid,
		'Digests only go out once an email transport is configured: ACP → Settings → Email. ' +
			'Send yourself a test email from that page first.');
	await upvote(uids.outsider, topics.digest.answerPid);
	await upvote(uids.reporter, topics.digest.answerPid);

	topics.welcome = await post(admin, cids.general, 'Welcome to the forum', 'Introduce yourself here.');
	topics.welcome.replyPid = await reply(uids.reporter, topics.welcome.tid, 'Hi all — glad to be here.');

	// Every character NodeBB escapes in a title, to catch double-decoding.
	topics.quoting = await post(
		uids.reporter, cids.general,
		'Tips for writing "good" bug reports <with examples>',
		'Include the version, the exact error text, and what you already tried.',
	);

	topics.staff = await post(admin, cids.staff, 'Internal: rotating the Redis password',
		'Rotate it quarterly and update config.json on every node.');

	// --- triage state, through Shotef's HTTP ticket routes ------------------
	await call(admin, 'PUT', ticket(topics.redis.tid, '/solved'), { pid: topics.redis.answerPid });
	await call(admin, 'PUT', ticket(topics.redis.tid, '/status'), { status: 'closed' });

	await call(admin, 'PUT', ticket(topics.symlink.tid, '/assignee'), { uid: uids.maintainer, teamId: TEAM_ID });
	await call(admin, 'PUT', ticket(topics.symlink.tid, '/priority'), { priority: 'high' });
	await call(admin, 'PUT', ticket(topics.symlink.tid, '/status'), { status: 'in_work' });

	await call(admin, 'PUT', ticket(topics.images.tid, '/status'), { status: 'blocked' });
	await call(admin, 'PUT', ticket(topics.digest.tid, '/status'), { status: 'responded' });

	// --- tokens for the identities the tests act as --------------------------
	const minted = mintTokens([admin, uids.maintainer, uids.outsider]);

	return {
		url: URL_BASE,
		seededAt: new Date().toISOString(),
		password: PASSWORD,
		teamId: TEAM_ID,
		teamName: 'Support & Ops',
		uids,
		cids,
		topics,
		tokens: {
			master: MASTER,
			admin: minted[admin],
			maintainer: minted[uids.maintainer],
			outsider: minted[uids.outsider],
		},
	};
}

(async () => {
	MASTER = mintTokens([0])['0'];
	await ensureBaseline();

	const existing = await readFixture();
	if (existing && !FRESH) {
		log(`fixture still intact on ${URL_BASE}; reusing ${FIXTURE_FILE} (pass --fresh to rebuild)`);
		return;
	}
	MASTER = mintTokens([0])['0'];
	await purge(existing ?? (existsSync(FIXTURE_FILE) ? JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) : undefined));

	const fixture = await seed();
	writeFileSync(FIXTURE_FILE, `${JSON.stringify(fixture, null, '\t')}\n`);
	log(`seeded ${Object.keys(fixture.topics).length} topics -> ${FIXTURE_FILE}`);
})().catch((err) => {
	process.stderr.write(`[seed] failed: ${err.stack || err.message}\n`);
	process.exit(1);
});
