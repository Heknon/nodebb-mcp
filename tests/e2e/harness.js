/**
 * End-to-end harness: real MCP server processes, over real stdio, against a
 * real NodeBB forum seeded by e2e/seed.mjs.
 *
 * Nothing here is faked. Each `spawnMcp()` launches `node dist/index.js` the
 * way an MCP client would, with its own environment (token, NODEBB_UID,
 * NODEBB_ENABLE_WRITES), so a suite can act as several forum identities side
 * by side — a reporter, a team member, a guest, a bad token.
 *
 * When no seeded forum is reachable every e2e test is *skipped*, not failed, so
 * `npm test` stays green on a laptop with no NodeBB. `npm run e2e` provisions
 * and seeds first (see e2e/run.sh).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// E2E_SERVER points the suite at another build (e.g. an installed release).
const SERVER = process.env.E2E_SERVER ? resolve(process.env.E2E_SERVER) : join(ROOT, 'dist/index.js');
export const FIXTURE_FILE = process.env.E2E_FIXTURE || join(ROOT, 'e2e/.fixture.json');

let cached;

/**
 * Which optional plugins are live on the forum right now, asked of the forum
 * itself (not of the MCP server under test): `searchEnabled` and the
 * `question-and-answer` key in /api/config, and Shotef's ping route.
 */
async function livePlugins(url) {
	const config = await (await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(5000) })).json();
	const ping = await fetch(`${url}/api/v3/plugins/shotef/ping`, { signal: AbortSignal.timeout(5000) });
	return {
		search: config.searchEnabled === true,
		qna: 'question-and-answer' in config,
		shotef: ping.ok,
	};
}

/** The seeded fixture, or a reason the suite cannot run. Probed once per process. */
export async function loadFixture() {
	if (cached) return cached;
	cached = (async () => {
		if (!existsSync(SERVER)) return { skip: 'dist/ is missing — run `npm run build` first.' };
		if (!existsSync(FIXTURE_FILE)) {
			return { skip: `no seeded forum (${FIXTURE_FILE} missing) — run \`npm run e2e\`.` };
		}
		const fixture = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8'));
		try {
			return { fixture, live: await livePlugins(fixture.url) };
		} catch (err) {
			return { skip: `forum at ${fixture.url} is not reachable (${err.message}) — start it with \`e2e/forum.sh up\`.` };
		}
	})();
	return cached;
}

/**
 * Test options for node:test: `{ skip: reason }` when the forum cannot serve
 * this suite. `needs: 'full'` wants dbsearch + Q&A + Shotef all active;
 * `needs: 'core'` wants all three deactivated (e2e/run.sh toggles them).
 *
 * Usage: `const { fixture, opts } = await e2e({ needs: 'full' }); test('…', opts, async () => …)`
 */
export async function e2e({ needs = 'full' } = {}) {
	const { fixture, live, skip } = await loadFixture();
	if (skip) return { fixture, opts: { skip } };
	const active = Object.entries(live).filter(([, on]) => on).map(([name]) => name);
	if (needs === 'full' && active.length !== 3) {
		return { fixture, live, opts: { skip: `needs dbsearch, Q&A and Shotef active; live: ${active.join(', ') || 'none'}` } };
	}
	if (needs === 'core' && active.length) {
		return { fixture, live, opts: { skip: `needs a core-only forum (\`e2e/forum.sh plugins off\`); live: ${active.join(', ')}` } };
	}
	return { fixture, live, opts: {} };
}

/**
 * Launch the MCP server as a child process and connect a real client over stdio.
 *
 * @param {object} fixture
 * @param {object} opts
 * @param {'admin'|'maintainer'|'outsider'|'master'|'anon'|string|{username:string,password:string}} [opts.as]
 *        which identity's token to use ('anon' = none; another string is a literal token),
 *        or `{ username, password }` to sign in with a password instead
 * @param {Record<string,string>} [opts.env] extra environment
 */
export async function spawnMcp(fixture, { as = 'admin', env = {} } = {}) {
	const childEnv = {
		PATH: process.env.PATH,
		NODEBB_URL: fixture.url,
		// One probe per process; e2e runs are short and must see fresh state.
		NODEBB_CAPABILITY_TTL_MS: '0',
		...env,
	};
	if (typeof as === 'object') {
		childEnv.NODEBB_USERNAME = as.username;
		childEnv.NODEBB_PASSWORD = as.password;
	} else if (as !== 'anon') {
		childEnv.NODEBB_API_TOKEN = fixture.tokens[as] ?? as;
	}

	const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: childEnv, stderr: 'pipe' });
	const stderr = [];
	transport.stderr?.on('data', chunk => stderr.push(String(chunk)));

	const client = new Client({ name: 'nodebb-mcp-e2e', version: '0.0.0' });
	await client.connect(transport);

	return {
		client,
		/** Server diagnostics (stderr), for asserting on startup logs. */
		get log() { return stderr.join(''); },
		async call(name, args = {}) {
			const result = await client.callTool({ name, arguments: args });
			return {
				text: result.content.map(part => part.text ?? '').join('\n'),
				isError: Boolean(result.isError),
			};
		},
		async close() {
			await client.close();
		},
	};
}

/** First capture group of `pattern` in `text`, as a number — for ids in tool output. */
export function grabId(text, pattern) {
	const match = pattern.exec(text);
	if (!match) throw new Error(`pattern ${pattern} not found in:\n${text}`);
	return Number(match[1]);
}

/** Poll `fn` until it returns truthy (search indexing and caches are asynchronous). */
export async function eventually(fn, { timeoutMs = 10_000, intervalMs = 250 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		// eslint-disable-next-line no-await-in-loop
		last = await fn();
		if (last) return last;
		// eslint-disable-next-line no-await-in-loop
		await new Promise(r => setTimeout(r, intervalMs));
	}
	return last;
}

/**
 * End the MCP connections the plugin suites made (apps named "e2e …" — on the test
 * forum only test clients are), so their NodeBB API tokens do not pile up.
 */
export async function revokeTestConnections(fixture) {
	const headers = { authorization: `Bearer ${fixture.tokens.admin}` };
	const res = await fetch(`${fixture.url}/api/admin/plugins/mcp`, { headers }).catch(() => undefined);
	if (!res?.ok) return;
	const { grants = [] } = await res.json();
	for (const grant of grants.filter(g => /^e2e /.test(g.clientName))) {
		// eslint-disable-next-line no-await-in-loop
		await fetch(`${fixture.url}/api/v3/plugins/mcp/grants/${grant.id}`, { method: 'DELETE', headers });
	}
}
