#!/usr/bin/env node
/**
 * nodebb-mcp — an MCP server over a NodeBB forum.
 *
 * Two ways to run:
 *  - stdio (default): one person's client starts the server and it acts as the
 *    configured forum account. stdout belongs to the protocol, so every
 *    diagnostic here goes to stderr.
 *  - HTTP (NODEBB_MCP_HTTP_PORT): one shared server; each person connects their
 *    own client and signs in with their own forum account over OAuth.
 *
 * Startup never blocks on the forum being reachable — a forum that is down
 * should surface as a tool result the caller can read, not as a server that
 * refuses to start.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ConfigError, loadConfig } from './config.js';
import { buildServer, SERVER_NAME, SERVER_VERSION } from './server.js';

function log(message: string): void {
	process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

async function main(): Promise<void> {
	let config;
	try {
		config = loadConfig();
	} catch (err) {
		if (err instanceof ConfigError) {
			log(`configuration error: ${err.message}`);
			log('Required: NODEBB_URL. Sign in with NODEBB_USERNAME + NODEBB_PASSWORD, or NODEBB_API_TOKEN (+ NODEBB_UID).');
			process.exit(78); // EX_CONFIG
		}
		throw err;
	}

	if (config.http) {
		const { startHttpServer } = await import('./http.js');
		const running = await startHttpServer(config, log);
		log(`v${SERVER_VERSION} serving ${config.url} over HTTP at ${running.url}/mcp — ` +
			`each person signs in with their own forum account${config.enableWrites ? '; public writes enabled' : ''}`);
		if (config.token || config.username) {
			log('NODEBB_API_TOKEN / NODEBB_USERNAME are not used in HTTP mode: every person signs in as themselves.');
		}
		const stop = (signal: string) => {
			log(`${signal} received, shutting down`);
			running.close().finally(() => process.exit(0));
		};
		process.on('SIGINT', () => stop('SIGINT'));
		process.on('SIGTERM', () => stop('SIGTERM'));
		return;
	}

	const { server, capabilities } = await buildServer(config);

	await server.connect(new StdioServerTransport());
	const signIn = config.token
		? 'API token'
		: config.username ? `signing in as ${config.username}` : 'anonymous';
	log(`v${SERVER_VERSION} ready, serving ${config.url} (${signIn})` +
		`${config.enableWrites ? ', public writes enabled' : ', public writes off'}`);
	if (config.token && config.username) {
		log('NODEBB_API_TOKEN is set, so NODEBB_USERNAME / NODEBB_PASSWORD are ignored.');
	}

	// Warm the capability cache so the first tool call is not paying for the
	// probe sweep. Failure here is not fatal: tools re-probe and report.
	capabilities
		.report()
		.then((caps) => {
			if (!caps.forum.reachable) {
				log(`warning: forum unreachable — ${caps.forum.reason ?? 'no detail'}`);
				return;
			}
			const live = [
				caps.search.state === 'available' ? 'search' : null,
				caps.qna.state === 'available' ? 'qna' : null,
				caps.shotef.state === 'available' ? 'shotef' : null,
			].filter(Boolean);
			log(`connected to ${caps.forum.title ?? config.url} as ${caps.forum.authenticated
				? `${caps.forum.username ?? 'uid'} (uid ${caps.forum.uid})`
				: 'guest'}`);
			if (caps.forum.authProblem) log(`warning: ${caps.forum.authProblem}`);
			if (caps.shotef.warning) log(`warning: ${caps.shotef.warning}`);
			log(live.length ? `optional features live: ${live.join(', ')}` : 'no optional features detected; running core-only');
		})
		.catch((err: unknown) => {
			log(`warning: capability probe failed — ${err instanceof Error ? err.message : String(err)}`);
		});

	const shutdown = (signal: string) => {
		log(`${signal} received, shutting down`);
		server.close().finally(() => process.exit(0));
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
	log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
	process.exit(1);
});
