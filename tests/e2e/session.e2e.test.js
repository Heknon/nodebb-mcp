/**
 * e2e: signing in with NODEBB_USERNAME / NODEBB_PASSWORD against the real
 * forum — NodeBB's own login, express-session cookies, csrf-sync tokens, and
 * Shotef routes behind setupApiRoute. Each server is its own process.
 *
 * Sessions are revoked through NodeBB's real API (the same thing a user does
 * from their account's "sessions" page), so renewal is tested against a session
 * the forum genuinely no longer honours.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { e2e, spawnMcp } from './harness.js';

const { fixture: fx, opts } = await e2e({ needs: 'full' });

const RUN = `r${Date.now().toString(36)}`;
const T = () => fx.topics;

let dir;
const sessionFile = name => join(dir, `${name}.json`);
const maintainer = () => ({ username: 'e2e_maintainer', password: fx.password });

test.before(async () => {
	dir = await mkdtemp(join(tmpdir(), 'nodebb-mcp-e2e-sessions-'));
});

/** Revoke every session e2e_maintainer has, via NodeBB's API (as the user, by token). */
async function revokeMaintainerSessions() {
	const auth = { authorization: `Bearer ${fx.tokens.maintainer}` };
	const page = await (await fetch(`${fx.url}/api/user/e2e_maintainer/sessions`, { headers: auth })).json();
	const uuids = (page.sessions ?? []).map(entry => entry.uuid);
	assert.ok(uuids.length, 'expected at least one session to revoke');
	for (const uuid of uuids) {
		// eslint-disable-next-line no-await-in-loop
		const res = await fetch(`${fx.url}/api/v3/users/${fx.uids.maintainer}/sessions/${uuid}`, { method: 'DELETE', headers: auth });
		assert.equal(res.status, 200, `revoking ${uuid}`);
	}
}

test('signs in with a password and acts as that user, verified by the forum', opts, async () => {
	const mcp = await spawnMcp(fx, { as: maintainer(), env: { NODEBB_SESSION_FILE: sessionFile('main') } });
	try {
		const { text } = await mcp.call('forum_capabilities');
		assert.match(text, new RegExp(`Acting as:\\*\\* e2e_maintainer \\(uid ${fx.uids.maintainer}\\) — verified by the forum`));
		assert.match(text, /Full-text search \| ✅ available/);
		assert.match(text, /Triage actions .* \| ✅ available/);
		assert.match(mcp.log, /signing in as e2e_maintainer/);

		const board = await mcp.call('get_triage_board', { team: fx.teamId });
		assert.match(board.text, /# Triage board — Support & Ops \(e2e-support\)/);
	} finally {
		await mcp.close();
	}
	// The session is cached for the next process, owner-only, without the password.
	const cached = await readFile(sessionFile('main'), 'utf8');
	assert.match(cached, /express\.sid/);
	assert.ok(!cached.includes(fx.password));
});

test('ticket actions and public writes go through with the session cookie and CSRF token', opts, async () => {
	const mcp = await spawnMcp(fx, {
		as: maintainer(),
		env: { NODEBB_SESSION_FILE: sessionFile('main'), NODEBB_ENABLE_WRITES: '1' },
	});
	try {
		const note = await mcp.call('add_ticket_note', { tid: T().symlink.tid, body: `password-session note ${RUN}` });
		assert.equal(note.isError, false, note.text);
		assert.match(note.text, /as e2e_maintainer — visible to the team only/);

		const reply = await mcp.call('reply_to_topic', { tid: T().welcome.tid, content: `Signed in with a password (${RUN}).` });
		assert.equal(reply.isError, false, reply.text);
		assert.match(reply.text, /Replied to topic #\d+ as e2e_maintainer/);

		const ticket = await mcp.call('get_ticket', { tid: T().symlink.tid });
		assert.match(ticket.text, new RegExp(`e2e_maintainer: password-session note ${RUN}`));
	} finally {
		await mcp.close();
	}
});

test('a new process reuses the cached session instead of signing in again', opts, async () => {
	const before = JSON.parse(await readFile(sessionFile('main'), 'utf8'));
	const mcp = await spawnMcp(fx, { as: maintainer(), env: { NODEBB_SESSION_FILE: sessionFile('main') } });
	try {
		const { text } = await mcp.call('forum_capabilities');
		assert.match(text, /Acting as:\*\* e2e_maintainer/);
	} finally {
		await mcp.close();
	}
	const after = JSON.parse(await readFile(sessionFile('main'), 'utf8'));
	// The file is rewritten only on a sign-in.
	assert.equal(after.savedAt, before.savedAt, 'no new sign-in');
	assert.deepEqual(after.cookies, before.cookies);
});

test('a session the forum revoked is renewed without the caller noticing', opts, async () => {
	const mcp = await spawnMcp(fx, {
		as: maintainer(),
		// Cache the capability probe as in production (otherwise each tool call's
		// re-probe of /api/config would notice the dead session first), and check
		// the session before every Write API read, so the test needs no clock.
		env: { NODEBB_SESSION_FILE: sessionFile('main'), NODEBB_SESSION_CHECK_MS: '0', NODEBB_CAPABILITY_TTL_MS: '3600000' },
	});
	try {
		await mcp.call('forum_capabilities');
		const before = JSON.parse(await readFile(sessionFile('main'), 'utf8'));

		await revokeMaintainerSessions();
		// NodeBB would now silently serve this board to a guest ("not a member of any team").
		const board = await mcp.call('get_triage_board', { team: fx.teamId });
		assert.equal(board.isError, false, board.text);
		assert.match(board.text, /# Triage board — Support & Ops \(e2e-support\)/);

		await revokeMaintainerSessions();
		// A write on the dead session fails CSRF; the client signs in again and retries.
		const note = await mcp.call('add_ticket_note', { tid: T().symlink.tid, body: `after revocation ${RUN}` });
		assert.equal(note.isError, false, note.text);

		const after = JSON.parse(await readFile(sessionFile('main'), 'utf8'));
		assert.notDeepEqual(after.cookies, before.cookies, 'a fresh session replaced the revoked one');
	} finally {
		await mcp.close();
	}
});

test('a wrong password fails loudly, with the forum\'s reason, and is tried once', opts, async () => {
	// A dedicated account: repeated runs may lock it (NodeBB: 5 failures an hour),
	// which this test accepts — either refusal must be explained.
	const file = sessionFile('wrong');
	const wrong = { username: 'e2e_wrongpass', password: 'definitely-not-it-1' };
	const first = await spawnMcp(fx, { as: wrong, env: { NODEBB_SESSION_FILE: file } });
	let refusal;
	try {
		const caps = await first.call('forum_capabilities');
		assert.match(caps.text, /Acting as:\*\* guest/);
		const match = /Sign-in problem:\*\* (.*invalid username or password.*|.*locked "e2e_wrongpass".*)/.exec(caps.text);
		assert.ok(match, caps.text);
		refusal = match[1];

		const topic = await first.call('get_topic', { tid: T().redis.tid });
		assert.equal(topic.isError, true);
		assert.match(topic.text, /rejected the sign-in|locked/);
	} finally {
		await first.close();
	}

	// A restart with the same wrong password does not try again (the refusal is remembered).
	const again = await spawnMcp(fx, { as: wrong, env: { NODEBB_SESSION_FILE: file } });
	try {
		const caps = await again.call('forum_capabilities');
		assert.match(caps.text, /Remembered from an earlier attempt/);
		assert.ok(caps.text.includes(refusal.slice(0, 40)));
	} finally {
		await again.close();
	}
	assert.ok(!(await readFile(file, 'utf8')).includes('definitely-not-it-1'));
});
