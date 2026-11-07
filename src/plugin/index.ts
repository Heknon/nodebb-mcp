/**
 * nodebb-plugin-mcp: the forum serves MCP itself.
 *
 *   POST /api/mcp                                        the MCP endpoint (bearer token)
 *   /api/mcp/oauth/{authorize,token,register,revoke}     OAuth 2.1 + dynamic registration
 *   /.well-known/oauth-authorization-server/api/mcp      OAuth metadata (RFC 8414)
 *   /.well-known/oauth-protected-resource/api/mcp        resource metadata (RFC 9728)
 *   /mcp/connect          the person allows or refuses an app (forum page, forum login)
 *   /mcp/connections      their connected apps, and how to connect one
 *   /admin/plugins/mcp    settings and every connection (ACP)
 *
 * The endpoints live in NodeBB's own API namespace (/api/mcp). Discovery is at
 * the origin root, as RFC 8414/9728 put it, so it is mounted on the app rather
 * than the router: a forum under a subpath needs no proxy rewrite for it.
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

/** Where the plugin answers, under the forum's relative path. */
export const MCP_PATH = '/api/mcp';
const WRITES_OFF = 'Public writes are off on this forum. An administrator can turn them on in ACP → Plugins → MCP.';
/** A connection nobody has used for this long has lost its refresh token: end it. */
const IDLE_GRANT_MS = 90 * 24 * 60 * 60 * 1000;
const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

interface Runtime {
	nbb: NodeBBRequire;
	store: PluginStore;
	provider: PluginOAuthProvider;
	/** Public forum URL, no trailing slash (links cite it). */
	url: string;
	/** The MCP endpoint's public URL (also the OAuth issuer and resource). */
	endpoint: string;
	relativePath: string;
	settings(): Promise<Settings>;
	configFor(grant: Grant): Promise<Config>;
	userFor(grant: Grant): Promise<{ config: Config; client: NodeBBClient; capabilities: CapabilityRegistry }>;
}

let runtime: Runtime | undefined;

/** Where the forum answers this process over loopback, so tool calls skip the public proxy. */
function loopbackUrl(nconf: { get(key: string): any }, publicUrl: string): string {
	// NodeBB terminating TLS itself: loopback would be https to 127.0.0.1, whose
	// certificate cannot match. Go through the public address instead.
	if (nconf.get('ssl')) return publicUrl;
	// A unix socket path (in `port`) is not a number: also the public address.
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
	let generation = 0;
	// NodeBB publishes a settings save to every forum process: re-read at once, everywhere.
	nbb('./src/pubsub').on('action:settings.set.mcp', () => {
		cached = undefined;
		generation += 1;
	});
	const settings = async (): Promise<Settings> => {
		if (cached && Date.now() - cached.at < 60_000) return cached.value;
		const started = generation;
		const raw = (await meta.settings.get('mcp')) ?? {};
		const on = (value: unknown) => value === true || value === 'on' || value === 'true' || value === '1';
		const value = { publicWrites: on(raw.publicWrites) };
		// A save landed while this read was in flight: use it once, but do not cache it.
		if (started === generation) cached = { at: Date.now(), value };
		return value;
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

	return { nbb, store, provider, url, endpoint: `${url}${MCP_PATH}`, relativePath, settings, configFor, userFor };
}

/** Discovery documents: at the origin root, path-aware (RFC 8414 §3, RFC 9728 §3). */
function discoveryPaths(rt: Runtime): { authorizationServer: string; protectedResource: string } {
	const path = new URL(rt.endpoint).pathname;
	return {
		authorizationServer: `/.well-known/oauth-authorization-server${path}`,
		protectedResource: `/.well-known/oauth-protected-resource${path}`,
	};
}

/**
 * The MCP and OAuth endpoints, as an Express 5 app of their own (NodeBB runs Express 4).
 * `rateLimits: false` (config.json `"mcp": { "rateLimits": false }`, test forums only)
 * turns off the SDK's per-IP limits on registration, authorization and tokens.
 */
function mcpApp(rt: Runtime, rateLimits: boolean): express.Express {
	const app = express();
	app.disable('x-powered-by');

	const issuer = new URL(rt.endpoint);
	const metadata = {
		issuer: issuer.href,
		authorization_endpoint: `${rt.endpoint}/oauth/authorize`,
		token_endpoint: `${rt.endpoint}/oauth/token`,
		registration_endpoint: `${rt.endpoint}/oauth/register`,
		revocation_endpoint: `${rt.endpoint}/oauth/revoke`,
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

	// Discovery: these requests arrive from the app (origin root, full path).
	const discovery = discoveryPaths(rt);
	app.use(discovery.authorizationServer, metadataHandler(metadata));
	app.use(discovery.protectedResource, metadataHandler(resourceMetadata));
	// The rest arrive from NodeBB's router (paths relative to the forum's root).
	const limits = rateLimits ? {} : { rateLimit: false as const };
	app.use(`${MCP_PATH}/oauth/authorize`, authorizationHandler({ provider: rt.provider, ...limits }));
	app.use(`${MCP_PATH}/oauth/token`, tokenHandler({ provider: rt.provider, ...limits }));
	app.use(`${MCP_PATH}/oauth/register`, clientRegistrationHandler({ clientsStore: rt.provider.clientsStore, ...limits }));
	app.use(`${MCP_PATH}/oauth/revoke`, revocationHandler({ provider: rt.provider, ...limits }));

	const bearer = requireBearerAuth({
		verifier: rt.provider,
		resourceMetadataUrl: `${new URL(rt.url).origin}${discovery.protectedResource}`,
	});

	// NodeBB has normally parsed the body already (its own size limit applies); this covers the rest.
	app.post(MCP_PATH, bearer, express.json(), async (req: Request, res: Response) => {
		try {
			const grant = req.auth?.extra?.grant as Grant | undefined;
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
	app.all(MCP_PATH, (_req: Request, res: Response) => {
		// No server-initiated streams or sessions to resume or end: this endpoint is stateless.
		res.set('Allow', 'POST').status(405).json(rpcError(-32000, 'Method not allowed: this MCP endpoint is stateless (POST only)'));
	});
	app.use((_req: Request, res: Response) => {
		res.status(404).json({ error: 'not_found' });
	});
	return app;
}

/**
 * Hand a request to the Express 5 app, and back to NodeBB untouched if it falls
 * through (it never should: the app answers everything it is given).
 */
function handOff(app: express.Express) {
	return (req: any, res: any, next: NextFunction) => {
		const requestProto = Object.getPrototypeOf(req);
		const responseProto = Object.getPrototypeOf(res);
		app(req, res, (err?: unknown) => {
			Object.setPrototypeOf(req, requestProto);
			Object.setPrototypeOf(res, responseProto);
			next(err);
		});
	};
}

/** Never let another site frame the Connect page (clickjacking the Allow button). */
function forbidFraming(res: any): void {
	res.set('X-Frame-Options', 'DENY');
	const csp = res.get('Content-Security-Policy');
	res.set('Content-Security-Policy', csp
		? (/frame-ancestors[^;]*/i.test(csp) ? csp.replace(/frame-ancestors[^;]*/i, "frame-ancestors 'none'") : `${csp}; frame-ancestors 'none'`)
		: "frame-ancestors 'none'");
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
	const nconf = nbb('nconf');

	const app = mcpApp(rt, nconf.get('mcp:rateLimits') !== false);
	const toApp = handOff(app);
	// NodeBB sets its 'trust proxy' when it starts listening, after this hook: copy it on first use,
	// or the OAuth rate limits would see every client as the proxy.
	let trustSynced = false;
	const syncTrust = () => {
		if (trustSynced) return;
		trustSynced = true;
		const trust = params.app?.get?.('trust proxy');
		// A bare `true` trusts every X-Forwarded-For hop, so anyone could forge a new IP per
		// request and step around the per-IP limits (express-rate-limit logs
		// ERR_ERL_PERMISSIVE_TRUST_PROXY for it). Trust the nearest proxy only; a forum
		// behind more proxies sets NodeBB's trust_proxy to that hop count.
		if (trust !== undefined) app.set('trust proxy', trust === true ? 1 : trust);
	};
	// The MCP + OAuth endpoints, in NodeBB's API namespace. (NodeBB's own /api/mcp/connect…,
	// the JSON side of the pages, stays NodeBB's.)
	router.use((req: any, res: any, next: NextFunction) => {
		if (req.path !== MCP_PATH && !req.path.startsWith(`${MCP_PATH}/oauth/`)) {
			next();
			return;
		}
		syncTrust();
		toApp(req, res, next);
	});
	// Discovery, at the origin root: on the app, ahead of NodeBB's router (which sits under the
	// forum's subpath, if any).
	const discovery = discoveryPaths(rt);
	params.app?.use?.((req: any, res: any, next: NextFunction) => {
		if (req.path !== discovery.authorizationServer && req.path !== discovery.protectedResource) {
			next();
			return;
		}
		syncTrust();
		toApp(req, res, next);
	});

	// Connections nobody has used for 90 days have lost their refresh tokens: end them (one process does it).
	if (nconf.get('runJobs')) {
		const sweep = () => {
			rt.store.idleGrants(IDLE_GRANT_MS)
				.then(idle => Promise.all(idle.map(grant => rt.provider.endGrant(grant.id).catch(() => {}))))
				.catch(err => process.stderr.write(`[nodebb-plugin-mcp] sweeping idle connections failed: ${String(err)}\n`));
		};
		setTimeout(sweep, 60_000).unref();
		setInterval(sweep, 6 * 60 * 60 * 1000).unref();
	}

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
		forbidFraming(res);
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
			endpoint: rt.endpoint,
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
			endpoint: rt.endpoint,
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
