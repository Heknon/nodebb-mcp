/**
 * nodebb-plugin-mcp: the forum serves MCP itself.
 *
 *   POST /mcp                                        the MCP endpoint (bearer token)
 *   /mcp/oauth/{authorize,token,register,revoke}     OAuth 2.1 + dynamic registration
 *   /.well-known/oauth-authorization-server/mcp      OAuth metadata (RFC 8414)
 *   /.well-known/oauth-protected-resource/mcp        resource metadata (RFC 9728)
 *   /mcp/connect          the person allows or refuses an app (forum page, forum login)
 *   /mcp/connections      their connected apps, and how to connect one
 *   /admin/plugins/mcp    settings and every connection (ACP)
 *
 * The MCP endpoint is stateless (a fresh server per request), so any process of
 * a multi-process forum can answer any request: identity comes from the bearer
 * token, and all OAuth state lives in the forum's database.
 *
 * Each person's tools act through their own NodeBB API token over the forum's
 * own HTTP API (loopback), so every call is checked by NodeBB — privileges,
 * bans, Shotef's team rules — exactly as for that person in a browser.
 */

import express, { type NextFunction, type Request, type Response } from 'express';

import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { CapabilityRegistry } from '../capabilities.js';
import { NodeBBClient } from '../client.js';
import type { Config } from '../config.js';
import { buildServer } from '../server.js';
import { PluginOAuthProvider, SCOPE, type NodeBBTokens } from './provider.js';
import { PluginStore, type Db, type Grant } from './store.js';

/** NodeBB's module loader (nodebb.require / require.main.require), handed over by library.cjs. */
export type NodeBBRequire = (path: string) => any;

interface HookParams {
	router: any;
	middleware: any;
	app?: any;
}

/** Settings saved from the ACP (`meta.settings` hash "mcp"; checkboxes are "on"/"off"). */
interface Settings {
	publicWrites: boolean;
}

const WRITES_OFF = 'Public writes are off on this forum. An administrator can turn them on in ACP → Plugins → MCP.';
const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

interface Runtime {
	nbb: NodeBBRequire;
	store: PluginStore;
	provider: PluginOAuthProvider;
	/** Public forum URL, no trailing slash (links cite it). */
	url: string;
	relativePath: string;
	settings(): Promise<Settings>;
	configFor(grant: Grant): Promise<Config>;
	userFor(grant: Grant): Promise<{ config: Config; client: NodeBBClient; capabilities: CapabilityRegistry }>;
}

let runtime: Runtime | undefined;

/** Where the forum answers this process over loopback, so tool calls skip the public proxy. */
function loopbackUrl(nconf: { get(key: string): any }, publicUrl: string): string {
	if (nconf.get('socketPath')) return publicUrl;
	const port = [].concat(nconf.get('port') ?? []).map(Number).find(Number.isFinite);
	if (!port) return publicUrl;
	const bind = String(nconf.get('bind_address') ?? '');
	const host = !bind || bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
	return `http://${host.includes(':') ? `[${host}]` : host}:${port}${nconf.get('relative_path') ?? ''}`;
}

function makeRuntime(nbb: NodeBBRequire): Runtime {
	const nconf = nbb('nconf');
	const db = nbb('./src/database') as Db;
	const meta = nbb('./src/meta');
	const tokens = nbb('./src/api/utils').tokens as NodeBBTokens;

	const url = String(nconf.get('url')).replace(/\/+$/, '');
	const relativePath = String(nconf.get('relative_path') ?? '');
	const apiUrl = loopbackUrl(nconf, url);

	const users = new Map<string, { writes: boolean; config: Config; client: NodeBBClient; capabilities: CapabilityRegistry }>();
	const store = new PluginStore(db);
	const provider = new PluginOAuthProvider(store, tokens, `${url}/mcp/connect`, grant => users.delete(grant.id));

	let cached: { at: number; value: Settings } | undefined;
	// NodeBB publishes a settings save to every forum process: re-read at once, everywhere.
	nbb('./src/pubsub').on('action:settings.set.mcp', () => {
		cached = undefined;
	});
	const settings = async (): Promise<Settings> => {
		if (cached && Date.now() - cached.at < 60_000) return cached.value;
		const raw = (await meta.settings.get('mcp')) ?? {};
		const on = (value: unknown) => value === true || value === 'on' || value === 'true' || value === '1';
		cached = { at: Date.now(), value: { publicWrites: on(raw.publicWrites) } };
		return cached.value;
	};

	const configFor = async (grant: Grant): Promise<Config> => ({
		url,
		apiUrl,
		token: grant.nodebbToken,
		uid: undefined,
		username: undefined,
		password: undefined,
		sessionFile: undefined,
		sessionCheckMs: 30_000,
		timeoutMs: 15_000,
		shotefNamespace: 'shotef',
		capabilityTtlMs: 60_000,
		maxPostsPerTopic: 50,
		enableWrites: (await settings()).publicWrites,
		writesOffReason: WRITES_OFF,
	});

	const userFor = async (grant: Grant) => {
		const config = await configFor(grant);
		const known = users.get(grant.id);
		if (known && known.writes === config.enableWrites) return known;
		const client = new NodeBBClient(config);
		const entry = { writes: config.enableWrites, config, client, capabilities: new CapabilityRegistry(client, config) };
		if (users.size >= 1000) users.delete(users.keys().next().value as string);
		users.set(grant.id, entry);
		return entry;
	};

	return { nbb, store, provider, url, relativePath, settings, configFor, userFor };
}

/** The MCP and OAuth endpoints, as an Express 5 app of their own (NodeBB runs Express 4). */
function mcpApp(rt: Runtime, trustProxy: unknown): express.Express {
	const app = express();
	app.disable('x-powered-by');
	if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

	const issuer = new URL(`${rt.url}/mcp`);
	const metadata = {
		issuer: issuer.href,
		authorization_endpoint: `${rt.url}/mcp/oauth/authorize`,
		token_endpoint: `${rt.url}/mcp/oauth/token`,
		registration_endpoint: `${rt.url}/mcp/oauth/register`,
		revocation_endpoint: `${rt.url}/mcp/oauth/revoke`,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
		revocation_endpoint_auth_methods_supported: ['client_secret_post'],
		scopes_supported: [SCOPE],
	};
	const resourceMetadata = {
		resource: issuer.href,
		authorization_servers: [issuer.href],
		scopes_supported: [SCOPE],
		resource_name: 'NodeBB forum (MCP)',
	};

	// Discovery lives at the origin root; on a forum under a subpath, the proxy must pass these through.
	app.use(`/.well-known/oauth-authorization-server${rt.relativePath}/mcp`, metadataHandler(metadata));
	app.use(`/.well-known/oauth-protected-resource${rt.relativePath}/mcp`, metadataHandler(resourceMetadata));
	app.use('/mcp/oauth/authorize', authorizationHandler({ provider: rt.provider }));
	app.use('/mcp/oauth/token', tokenHandler({ provider: rt.provider }));
	app.use('/mcp/oauth/register', clientRegistrationHandler({ clientsStore: rt.provider.clientsStore }));
	app.use('/mcp/oauth/revoke', revocationHandler({ provider: rt.provider }));

	const bearer = requireBearerAuth({
		verifier: rt.provider,
		resourceMetadataUrl: `${new URL(rt.url).origin}/.well-known/oauth-protected-resource${new URL(rt.url).pathname.replace(/\/$/, '')}/mcp`,
	});

	app.post('/mcp', bearer, express.json({ limit: '4mb' }), async (req: Request, res: Response) => {
		try {
			const grant = await rt.store.getGrant(String(req.auth?.extra?.grantId ?? ''));
			if (!grant) {
				res.status(401).json(rpcError(-32001, 'This connection has ended; connect again'));
				return;
			}
			const user = await rt.userFor(grant);
			const { server } = await buildServer(user.config, { client: user.client, capabilities: user.capabilities });
			// Stateless: any process of the forum can answer; nothing outlives the request.
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			res.on('close', () => {
				void transport.close();
				void server.close();
			});
			await server.connect(transport);
			await transport.handleRequest(req, res, req.body);
		} catch (err) {
			if (!res.headersSent) res.status(500).json(rpcError(-32603, 'Internal server error'));
			process.stderr.write(`[nodebb-plugin-mcp] MCP request failed: ${err instanceof Error ? err.stack : String(err)}\n`);
		}
	});
	app.all('/mcp', (_req: Request, res: Response) => {
		// No server-initiated streams or sessions to resume or end: this endpoint is stateless.
		res.set('Allow', 'POST').status(405).json(rpcError(-32000, 'Method not allowed: this MCP endpoint is stateless (POST only)'));
	});
	app.use((_req: Request, res: Response) => {
		res.status(404).json({ error: 'not_found' });
	});
	return app;
}

/** Paths the Express 5 app owns; everything else stays NodeBB's. */
function isMcpPath(path: string): boolean {
	return path === '/mcp' || path.startsWith('/mcp/oauth/') ||
		path.startsWith('/.well-known/oauth-authorization-server/') || path.startsWith('/.well-known/oauth-protected-resource/');
}

const isoDate = (ms?: number) => (ms ? new Date(ms).toISOString() : '');

function view(grant: Grant) {
	return {
		id: grant.id,
		clientName: grant.clientName,
		username: grant.username,
		uid: grant.uid,
		createdAtISO: isoDate(grant.createdAt),
		lastUsedAtISO: isoDate(grant.lastUsedAt),
		used: Boolean(grant.lastUsedAt),
	};
}

export async function init(params: HookParams, nbb: NodeBBRequire): Promise<void> {
	const rt = makeRuntime(nbb);
	runtime = rt;
	const { router, middleware } = params;
	const routeHelpers = nbb('./src/routes/helpers');
	const user = nbb('./src/user');
	const meta = nbb('./src/meta');

	// The MCP + OAuth endpoints: handed to the Express 5 app, then back to NodeBB untouched.
	const app = mcpApp(rt, params.app?.get?.('trust proxy'));
	router.use((req: any, res: any, next: NextFunction) => {
		if (!isMcpPath(req.path)) {
			next();
			return;
		}
		const requestProto = Object.getPrototypeOf(req);
		const responseProto = Object.getPrototypeOf(res);
		app(req, res, (err?: unknown) => {
			Object.setPrototypeOf(req, requestProto);
			Object.setPrototypeOf(res, responseProto);
			next(err);
		});
	});

	const formMiddleware = [middleware.authenticateRequest, middleware.applyCSRF, middleware.ensureLoggedIn];
	const usernameOf = async (uid: number) => String(await user.getUserField(uid, 'username'));

	// Allow or refuse an app: an ordinary forum page, behind the forum's own login.
	routeHelpers.setupPageRoute(router, '/mcp/connect', [middleware.ensureLoggedIn], async (req: any, res: any) => {
		const requestId = String(req.query.request ?? '');
		const pending = await rt.provider.pending(requestId);
		let redirectHost = '';
		try {
			if (pending) redirectHost = new URL(pending.redirectUri).host;
		} catch {
			redirectHost = pending?.redirectUri ?? '';
		}
		res.render('mcp/connect', {
			title: 'Connect an app',
			found: Boolean(pending),
			requestId,
			clientName: pending?.clientName || 'An MCP client',
			redirectHost,
			forumName: meta.config.title || 'this forum',
			username: await usernameOf(req.uid),
		});
	});
	router.post('/mcp/connect', formMiddleware, routeHelpers.tryRoute(async (req: any, res: any) => {
		const requestId = String(req.body?.request ?? '');
		const back = await rt.provider.decide(
			requestId,
			{ uid: req.uid, username: await usernameOf(req.uid) },
			req.body?.action === 'allow',
		);
		if (!back) {
			res.redirect(`${rt.relativePath}/mcp/connect?request=${encodeURIComponent(requestId)}`);
			return;
		}
		res.redirect(back.href);
	}));

	// The person's own connections: see them, end any.
	routeHelpers.setupPageRoute(router, '/mcp/connections', [middleware.ensureLoggedIn], async (req: any, res: any) => {
		const grants = await rt.store.listGrants(req.uid);
		res.render('mcp/connections', {
			title: 'Connected apps',
			endpoint: `${rt.url}/mcp`,
			grants: grants.map(view),
			hasGrants: grants.length > 0,
		});
	});
	router.post('/mcp/connections/disconnect', formMiddleware, routeHelpers.tryRoute(async (req: any, res: any) => {
		const grant = await rt.store.getGrant(String(req.body?.grant ?? ''));
		if (grant && grant.uid === req.uid) await rt.provider.endGrant(grant.id);
		res.redirect(`${rt.relativePath}/mcp/connections`);
	}));

	// ACP: settings, and every connection on the forum.
	routeHelpers.setupAdminPageRoute(router, '/admin/plugins/mcp', async (_req: any, res: any) => {
		const grants = await rt.store.listGrants();
		res.render('admin/plugins/mcp', {
			title: 'MCP',
			endpoint: `${rt.url}/mcp`,
			grants: grants.map(view),
			hasGrants: grants.length > 0,
		});
	});
}

/** DELETE /api/v3/plugins/mcp/grants/:id — an administrator, or the person themselves. */
export async function apiRoutes(params: HookParams, nbb: NodeBBRequire): Promise<void> {
	const routeHelpers = nbb('./src/routes/helpers');
	const helpers = nbb('./src/controllers/helpers');
	const user = nbb('./src/user');
	routeHelpers.setupApiRoute(params.router, 'delete', '/mcp/grants/:id', [params.middleware.ensureLoggedIn], async (req: any, res: any) => {
		const rt = runtime;
		const grant = rt ? await rt.store.getGrant(String(req.params.id)) : undefined;
		if (!rt || !grant) {
			helpers.formatApiResponse(404, res, new Error('[[error:invalid-data]]'));
			return;
		}
		if (grant.uid !== req.uid && !(await user.isAdministrator(req.uid))) {
			helpers.formatApiResponse(403, res, new Error('[[error:no-privileges]]'));
			return;
		}
		await rt.provider.endGrant(grant.id);
		helpers.formatApiResponse(200, res, { ended: grant.id });
	});
}

export function adminMenu(header: { plugins: unknown[] }): { plugins: unknown[] } {
	header.plugins.push({ route: '/plugins/mcp', icon: 'fa-plug', name: 'MCP' });
	return header;
}
