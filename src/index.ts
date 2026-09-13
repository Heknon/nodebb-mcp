#!/usr/bin/env node
/**
 * nodebb-mcp — an MCP server over a NodeBB forum.
 *
 * Transport is stdio, so stdout belongs to the protocol: every diagnostic here
 * goes to stderr. Startup never blocks on the forum being reachable — a forum
 * that is down should surface as a tool result the caller can read, not as a
 * server that refuses to start.
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
			log('Required: NODEBB_URL. Optional: NODEBB_API_TOKEN, NODEBB_UID, NODEBB_TIMEOUT_MS.');
			process.exit(78); // EX_CONFIG
		}
		throw err;
	}

	const { server, capabilities } = await buildServer(config);

	await server.connect(new StdioServerTransport());
	log(`v${SERVER_VERSION} ready, serving ${config.url}${config.token ? ' (authenticated)' : ' (anonymous)'}`);

	// Warm the capability cache so the first tool call is not paying for the
	// probe sweep. Failure here is not fatal: tools re-probe and report.
	capabilities
		.get()
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
			log(`connected to ${caps.forum.title ?? config.url}${caps.forum.version ? ` (NodeBB ${caps.forum.version})` : ''}`);
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
