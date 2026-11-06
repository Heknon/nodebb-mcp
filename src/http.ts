/**
 * nodebb-mcp as a shared HTTP server (MCP streamable HTTP), where each person
 * connects their own client and signs in with their own forum account.
 *
 *   /.well-known/oauth-authorization-server   OAuth metadata (RFC 8414)
 *   /.well-known/oauth-protected-resource/mcp protected-resource metadata (RFC 9728)
 *   /register /authorize /token /revoke       OAuth 2.1 + dynamic registration (SDK handlers)
 *   /oauth/sign-in                            the sign-in form's target
 *   /mcp                                      the MCP endpoint (bearer token required)
 *
 * Isolation: every grant (one person, one client) gets its own forum client
 * and capability registry, built from that person's forum session; every MCP
 * session is bound to the grant that opened it, so a token can never drive
 * another person's session. NODEBB_ENABLE_WRITES still decides, for everyone,
 * whether the public write tools exist.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import express, { type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';

import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { CapabilityRegistry } from './capabilities.js';
import { NodeBBClient } from './client.js';
import type { Config } from './config.js';
import { ForumOAuthProvider, SCOPE } from './oauth/provider.js';
import { OAuthStore } from './oauth/store.js';
import { buildServer } from './server.js';
import { PasswordSession } from './session.js';

export interface RunningHttpServer {
	/** The public base URL; the MCP endpoint is `${url}/mcp`. */
	url: string;
	store: OAuthStore;
	close(): Promise<void>;
}

interface UserContext {
	client: NodeBBClient;
	capabilities: CapabilityRegistry;
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

async function forumTitle(config: Config): Promise<string> {
	try {
		const res = await fetch(`${config.url}/api/config`, { signal: AbortSignal.timeout(config.timeoutMs) });
		const body = await res.json() as { siteTitle?: string };
		if (body.siteTitle) return body.siteTitle;
	} catch {
		// Fall back to the host name.
	}
	return new URL(config.url).host;
}

export async function startHttpServer(config: Config, log: (message: string) => void = () => {}): Promise<RunningHttpServer> {
	const http = config.http;
	if (!http) throw new Error('startHttpServer needs NODEBB_MCP_HTTP_PORT');

	// Bind first, so the public URL can name the real port when none was configured.
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(http.port, http.host, () => resolve());
	});
	const port = (server.address() as AddressInfo).port;
	const publicUrl = http.publicUrl ?? `http://localhost:${port}`;
	const issuerUrl = new URL(publicUrl);
	const mcpUrl = new URL('/mcp', issuerUrl);

	const store = new OAuthStore(config.url, http.stateFile);
	await store.load();
	const forumName = await forumTitle(config);

	const users = new Map<string, UserContext>();
	const sessions = new Map<string, { transport: StreamableHTTPServerTransport; grantId: string }>();

	// A grant ended (forum session over, or revoked): forget its forum client.
	// Its MCP sessions are refused from now on by the bearer check, and swept.
	const forgetGrant = (grantId: string) => {
		users.delete(grantId);
	};
	const provider = new ForumOAuthProvider(config, store, forumName, grant => forgetGrant(grant.id));

	const userFor = (grantId: string): UserContext | undefined => {
		const known = users.get(grantId);
		if (known) return known;
		const grant = store.liveGrant(grantId);
		if (!grant) return undefined;
		const session = new PasswordSession({
			url: config.url,
			username: grant.username,
			initial: grant.session,
			sessionFile: undefined,
			timeoutMs: config.timeoutMs,
			onChange: state => store.updateGrantSession(grantId, state),
			onEnded: () => {
				store.endGrant(grantId);
				forgetGrant(grantId);
			},
		});
		const client = new NodeBBClient(config, { session });
		const user = { client, capabilities: new CapabilityRegistry(client, config) };
		users.set(grantId, user);
		return user;
	};

	const app = express();
	app.disable('x-powered-by');

	app.use(mcpAuthRouter({
		provider,
		issuerUrl,
		resourceServerUrl: mcpUrl,
		scopesSupported: [SCOPE],
		resourceName: `${forumName} (NodeBB)`,
	}));

	app.post(
		'/oauth/sign-in',
		// Each attempt is a forum login, which NodeBB itself limits per account and per IP.
		rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
		express.urlencoded({ extended: false, limit: '8kb' }),
		(req: Request, res: Response) => {
			provider.completeSignIn(res, req.body ?? {}).catch((err: unknown) => {
				log(`sign-in failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
				if (!res.headersSent) res.status(500).type('text').send('Signing in failed.');
			});
		},
	);

	app.get('/healthz', (_req: Request, res: Response) => {
		res.json({ ok: true, forum: config.url });
	});

	const loopback = ['127.0.0.1', 'localhost', '::1'].includes(http.host);
	const bearer = requireBearerAuth({
		verifier: provider,
		resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
	});

	app.all('/mcp', bearer, express.json({ limit: '4mb' }), async (req: Request, res: Response) => {
		const grantId = String(req.auth?.extra?.grantId ?? '');
		const sessionId = req.header('mcp-session-id');
		try {
			if (sessionId) {
				const entry = sessions.get(sessionId);
				if (!entry) {
					res.status(404).json(rpcError(-32001, 'Session not found'));
					return;
				}
				if (entry.grantId !== grantId) {
					res.status(403).json(rpcError(-32003, 'This MCP session belongs to another sign-in'));
					return;
				}
				await entry.transport.handleRequest(req, res, req.body);
				return;
			}
			if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
				res.status(400).json(rpcError(-32000, 'Bad Request: no valid MCP session'));
				return;
			}
			const user = userFor(grantId);
			if (!user) {
				res.status(401).json(rpcError(-32001, 'The sign-in has ended; reconnect to sign in again'));
				return;
			}
			const { server: mcp } = await buildServer(config, user);
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: id => {
					sessions.set(id, { transport, grantId });
				},
				...(loopback
					? {
						// A loopback server is reachable from any web page's DNS-rebinding trick; pin the Host.
						enableDnsRebindingProtection: true,
						allowedHosts: [issuerUrl.host, `localhost:${port}`, `127.0.0.1:${port}`],
					}
					: {}),
			});
			transport.onclose = () => {
				if (transport.sessionId) sessions.delete(transport.sessionId);
			};
			await mcp.connect(transport);
			await transport.handleRequest(req, res, req.body);
		} catch (err) {
			log(`MCP request failed: ${err instanceof Error ? err.message : String(err)}`);
			if (!res.headersSent) res.status(500).json(rpcError(-32603, 'Internal server error'));
		}
	});

	// Drop MCP sessions whose sign-in has ended.
	const sweep = setInterval(() => {
		for (const [id, entry] of sessions) {
			if (!store.liveGrant(entry.grantId)) {
				sessions.delete(id);
				void entry.transport.close();
			}
		}
	}, 5 * 60_000);
	sweep.unref();

	server.on('request', (req: IncomingMessage, res: ServerResponse) => {
		app(req, res);
	});

	return {
		url: publicUrl,
		store,
		async close() {
			clearInterval(sweep);
			await Promise.all([...sessions.values()].map(entry => entry.transport.close().catch(() => {})));
			sessions.clear();
			await store.flush();
			server.closeAllConnections?.();
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}
