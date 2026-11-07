import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { runDiagnostics } from '../dist/plugin/diagnostics.js';
import { startFakeForum } from './fake-forum.js';

/** A port with nothing listening (bound, then released). */
async function closedPort() {
	const srv = createServer();
	await new Promise(r => srv.listen(0, '127.0.0.1', r));
	const { port } = srv.address();
	await new Promise(r => srv.close(r));
	return port;
}

const nconf = (values = {}) => ({ get: key => values[key] });
const byId = (report, id) => report.checks.find(c => c.id === id);

test('loopback refused, public fine: falls back, and says why loopback failed', async (t) => {
	const forum = await startFakeForum();
	t.after(() => forum.close());
	const port = await closedPort();
	const report = await runDiagnostics({
		url: forum.url, apiUrl: `http://127.0.0.1:${port}`, relativePath: '', endpoint: `${forum.url}/api/mcp`,
		nconf: nconf({ port }), trustProxy: 1, timeoutMs: 2000,
	});
	assert.equal(report.route, 'public');
	const loop = byId(report, 'loopback');
	assert.equal(loop.status, 'fail');
	assert.match(loop.summary, /ECONNREFUSED/);
	assert.match(loop.advice, /port/);
	assert.equal(byId(report, 'public').status, 'ok');
	assert.equal(byId(report, 'dns').status, 'ok');
});

test('nothing reachable: the verdict is fail and every route explains itself', async () => {
	const a = await closedPort();
	const b = await closedPort();
	const report = await runDiagnostics({
		url: `http://127.0.0.1:${b}`, apiUrl: `http://127.0.0.1:${a}`, relativePath: '', endpoint: `http://127.0.0.1:${b}/api/mcp`,
		nconf: nconf({ port: a }), trustProxy: undefined, timeoutMs: 2000,
	});
	assert.equal(report.verdict, 'fail');
	assert.equal(report.route, 'none');
	for (const id of ['loopback', 'public']) {
		assert.equal(byId(report, id).status, 'fail');
		assert.ok(byId(report, id).advice);
	}
});

test('something other than NodeBB answering is called out', async (t) => {
	const { createServer: http } = await import('node:http');
	const srv = http((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<h1>Welcome to nginx</h1>'); });
	await new Promise(r => srv.listen(0, '127.0.0.1', r));
	t.after(() => srv.close());
	const url = `http://127.0.0.1:${srv.address().port}`;
	const report = await runDiagnostics({ url, apiUrl: url, relativePath: '', endpoint: `${url}/api/mcp`, nconf: nconf({}), trustProxy: undefined, timeoutMs: 2000 });
	const pub = byId(report, 'public');
	assert.equal(pub.status, 'fail');
	assert.match(pub.advice, /not NodeBB/);
	assert.match(pub.details.bodyStart, /nginx/);
});

test('a large /api/config (real forums are well over 4 KB) is still recognised as NodeBB', async (t) => {
	const { createServer: http } = await import('node:http');
	const config = { relative_path: '', siteTitle: 'Big Forum', padding: 'x'.repeat(20000) };
	const srv = http((_req, res) => { res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(config)); });
	await new Promise(r => srv.listen(0, '127.0.0.1', r));
	t.after(() => srv.close());
	const url = `http://127.0.0.1:${srv.address().port}`;
	const report = await runDiagnostics({ url, apiUrl: url, relativePath: '', endpoint: `${url}/api/mcp`, nconf: nconf({}), trustProxy: undefined, timeoutMs: 2000 });
	const pub = byId(report, 'public');
	assert.equal(pub.status, 'ok', pub.summary);
	assert.match(pub.summary, /Big Forum/);
});
