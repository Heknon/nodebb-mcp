/**
 * The plugin's OAuth state, in NodeBB's own database — so it works on Redis,
 * Mongo and Postgres alike, and across the processes of a multi-process forum.
 *
 *   mcp:client:<id>          a registered client (dynamic client registration)
 *   mcp:pending:<id>         an authorization waiting for the person's consent (10 min)
 *   mcp:code:<code>          a one-time authorization code (1 min)
 *   mcp:grant:<id>           one person + one client: uid and the NodeBB API token
 *   mcp:grants               every grant id, by creation time (the ACP list)
 *   mcp:grants:uid:<uid>     one person's grant ids (their connections page)
 *   mcp:grants:lastUsed      grant ids by last use (shown in lists; idle grants are swept)
 *   mcp:token:<sha256>       an access or refresh token; only its hash is stored
 *   mcp:grant:<id>:tokens    the grant's token hashes, scored by expiry
 *
 * Values are JSON in a `data` field (NodeBB stores hash fields as strings).
 * Expiry is set after each write: on Mongo it is a field of the object.
 * Single use (codes, rotating refresh tokens) is enforced with an atomic
 * counter, so two processes racing for the same code cannot both win.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export const ACCESS_TOKEN_TTL_S = 60 * 60;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;

/** The subset of NodeBB's database module the store uses. */
export interface Db {
	getObject(key: string): Promise<Record<string, unknown> | null>;
	getObjects(keys: string[]): Promise<(Record<string, unknown> | null)[]>;
	setObject(key: string, data: Record<string, unknown>): Promise<void>;
	incrObjectField(key: string, field: string): Promise<number>;
	delete(key: string): Promise<void>;
	deleteAll(keys: string[]): Promise<void>;
	expireAt(key: string, timestampSeconds: number): Promise<void>;
	sortedSetAdd(key: string, score: number, value: string): Promise<void>;
	sortedSetRemove(key: string, value: string): Promise<void>;
	sortedSetScore(key: string, value: string): Promise<number | null>;
	sortedSetsRemoveRangeByScore(keys: string[], min: number | '-inf', max: number | '+inf'): Promise<void>;
	getSortedSetRange(key: string, start: number, stop: number): Promise<string[]>;
	getSortedSetRevRange(key: string, start: number, stop: number): Promise<string[]>;
}

export interface PendingAuthorization {
	id: string;
	clientId: string;
	clientName?: string;
	redirectUri: string;
	codeChallenge: string;
	state?: string;
	scopes: string[];
	resource?: string;
	expiresAt: number;
}

/**
 * A one-time code. The grant (and its NodeBB API token) is made only when the
 * client redeems it, so an Allow that never comes back leaves nothing behind.
 */
export interface AuthorizationCode {
	uid: number;
	username: string;
	clientId: string;
	clientName: string;
	redirectUri: string;
	codeChallenge: string;
	scopes: string[];
	resource?: string;
	expiresAt: number;
}

export interface Grant {
	id: string;
	uid: number;
	username: string;
	clientId: string;
	clientName: string;
	/** The NodeBB API token the person's tools act through (listed in ACP → API Access). */
	nodebbToken: string;
	createdAt: number;
	lastUsedAt?: number;
}

interface StoredToken {
	kind: 'access' | 'refresh';
	grantId: string;
	clientId: string;
	scopes: string[];
	resource?: string;
	expiresAt: number;
}

export interface IssuedTokens {
	access_token: string;
	token_type: 'bearer';
	expires_in: number;
	refresh_token: string;
	scope?: string;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
/** Keys are built from these; anything else is not one of ours. */
const isId = (value: string) => /^[A-Za-z0-9_-]{8,128}$/.test(value);

export class PluginStore {
	constructor(
		private readonly db: Db,
		private readonly now: () => number = Date.now,
	) {}

	private async read<T>(key: string): Promise<T | undefined> {
		const object = await this.db.getObject(key);
		if (typeof object?.data !== 'string') return undefined;
		try {
			return JSON.parse(object.data) as T;
		} catch {
			return undefined;
		}
	}

	private async write(key: string, value: unknown, expiresAtMs?: number): Promise<void> {
		await this.db.setObject(key, { data: JSON.stringify(value) });
		if (expiresAtMs) await this.db.expireAt(key, Math.ceil(expiresAtMs / 1000));
	}

	/** Take a key's value once: of any number of concurrent callers, exactly one gets it. */
	private async takeOnce<T>(key: string): Promise<T | undefined> {
		const first = (await this.db.incrObjectField(key, 'taken')) === 1;
		const value = first ? await this.read<T>(key) : undefined;
		await this.db.delete(key);
		return value;
	}

	/* ---------------------------------------------------------- clients */

	async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
		return isId(clientId) ? this.read(`mcp:client:${clientId}`) : undefined;
	}

	async registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> {
		const full: OAuthClientInformationFull = {
			...client,
			client_id: randomUUID(),
			client_id_issued_at: Math.floor(this.now() / 1000),
		};
		await this.write(`mcp:client:${full.client_id}`, full);
		return full;
	}

	/* ---------------------------------------------------------- consent */

	async addPending(request: Omit<PendingAuthorization, 'id' | 'expiresAt'>): Promise<PendingAuthorization> {
		const pending: PendingAuthorization = { ...request, id: secret(), expiresAt: this.now() + PENDING_TTL_MS };
		await this.write(`mcp:pending:${pending.id}`, pending, pending.expiresAt);
		return pending;
	}

	async getPending(id: string): Promise<PendingAuthorization | undefined> {
		if (!isId(id)) return undefined;
		const pending = await this.read<PendingAuthorization>(`mcp:pending:${id}`);
		return pending && pending.expiresAt >= this.now() ? pending : undefined;
	}

	/** Consume a pending authorization (consent given or refused). */
	async takePending(id: string): Promise<PendingAuthorization | undefined> {
		if (!isId(id)) return undefined;
		const pending = await this.takeOnce<PendingAuthorization>(`mcp:pending:${id}`);
		return pending && pending.expiresAt >= this.now() ? pending : undefined;
	}

	/* ------------------------------------------------------------ codes */

	async addCode(code: Omit<AuthorizationCode, 'expiresAt'>): Promise<string> {
		const value = secret();
		const expiresAt = this.now() + CODE_TTL_MS;
		await this.write(`mcp:code:${hash(value)}`, { ...code, expiresAt }, expiresAt);
		return value;
	}

	async peekCode(code: string): Promise<AuthorizationCode | undefined> {
		const entry = await this.read<AuthorizationCode>(`mcp:code:${hash(code)}`);
		return entry && entry.expiresAt >= this.now() ? entry : undefined;
	}

	/** Codes are single-use. */
	async takeCode(code: string): Promise<AuthorizationCode | undefined> {
		const entry = await this.takeOnce<AuthorizationCode>(`mcp:code:${hash(code)}`);
		return entry && entry.expiresAt >= this.now() ? entry : undefined;
	}

	/* ----------------------------------------------------------- grants */

	async createGrant(grant: Omit<Grant, 'id' | 'createdAt'>): Promise<Grant> {
		const full: Grant = { ...grant, id: randomUUID(), createdAt: this.now() };
		await this.write(`mcp:grant:${full.id}`, full);
		await this.db.sortedSetAdd('mcp:grants', full.createdAt, full.id);
		await this.db.sortedSetAdd(`mcp:grants:uid:${full.uid}`, full.createdAt, full.id);
		return full;
	}

	async getGrant(id: string): Promise<Grant | undefined> {
		if (!isId(id)) return undefined;
		const [grant, lastUsed] = await Promise.all([
			this.read<Grant>(`mcp:grant:${id}`),
			this.db.sortedSetScore('mcp:grants:lastUsed', id),
		]);
		if (!grant) return undefined;
		return lastUsed ? { ...grant, lastUsedAt: Number(lastUsed) } : grant;
	}

	/** Newest first: everyone's (the ACP), or one person's. */
	async listGrants(uid?: number, limit = 200): Promise<Grant[]> {
		const ids = await this.db.getSortedSetRevRange(uid === undefined ? 'mcp:grants' : `mcp:grants:uid:${uid}`, 0, limit - 1);
		const grants = await Promise.all(ids.map(id => this.getGrant(id)));
		return grants.filter((grant): grant is Grant => Boolean(grant));
	}

	/**
	 * Note use, at most once a minute (lists show it; idle grants are swept). A
	 * sorted set, not a field of the grant: a touch racing endGrant can then only
	 * leave a stray member, which the sweep removes, never a recreated grant key.
	 */
	async touchGrant(grant: Grant): Promise<void> {
		if (grant.lastUsedAt && this.now() - grant.lastUsedAt < 60_000) return;
		await this.db.sortedSetAdd('mcp:grants:lastUsed', this.now(), grant.id);
	}

	/**
	 * Grants unused for `maxIdleMs` (their refresh tokens have lapsed by then), for
	 * the caller to end with everything they hold; stray index entries are dropped.
	 */
	async idleGrants(maxIdleMs: number): Promise<Grant[]> {
		const cutoff = this.now() - maxIdleMs;
		const idle: Grant[] = [];
		for (const id of await this.db.getSortedSetRange('mcp:grants', 0, -1)) {
			// eslint-disable-next-line no-await-in-loop
			const grant = await this.getGrant(id);
			if (!grant) {
				// eslint-disable-next-line no-await-in-loop
				await this.db.sortedSetRemove('mcp:grants', id);
				continue;
			}
			if ((grant.lastUsedAt ?? grant.createdAt) < cutoff) idle.push(grant);
		}
		for (const id of await this.db.getSortedSetRange('mcp:grants:lastUsed', 0, -1)) {
			// eslint-disable-next-line no-await-in-loop
			if (!(await this.read(`mcp:grant:${id}`))) await this.db.sortedSetRemove('mcp:grants:lastUsed', id);
		}
		return idle;
	}

	/** End a grant and every token it issued. Returns it, so the caller can drop its NodeBB token. */
	async endGrant(id: string): Promise<Grant | undefined> {
		const grant = await this.getGrant(id);
		if (!grant) return undefined;
		const tokens = await this.db.getSortedSetRange(`mcp:grant:${id}:tokens`, 0, -1);
		await this.db.deleteAll([...tokens.map(t => `mcp:token:${t}`), `mcp:grant:${id}:tokens`, `mcp:grant:${id}`]);
		await this.db.sortedSetRemove('mcp:grants', id);
		await this.db.sortedSetRemove(`mcp:grants:uid:${grant.uid}`, id);
		await this.db.sortedSetRemove('mcp:grants:lastUsed', id);
		return grant;
	}

	/* ----------------------------------------------------------- tokens */

	async issueTokens(grantId: string, clientId: string, scopes: string[], resource?: string): Promise<IssuedTokens> {
		const access = secret();
		const refresh = secret();
		const now = this.now();
		const accessExpires = now + ACCESS_TOKEN_TTL_S * 1000;
		const refreshExpires = now + REFRESH_TOKEN_TTL_MS;
		const index = `mcp:grant:${grantId}:tokens`;
		await this.write(`mcp:token:${hash(access)}`, { kind: 'access', grantId, clientId, scopes, resource, expiresAt: accessExpires }, accessExpires);
		await this.write(`mcp:token:${hash(refresh)}`, { kind: 'refresh', grantId, clientId, scopes, resource, expiresAt: refreshExpires }, refreshExpires);
		await this.db.sortedSetAdd(index, accessExpires, hash(access));
		await this.db.sortedSetAdd(index, refreshExpires, hash(refresh));
		// The tokens themselves expire in the database; keep the index from growing with them.
		await this.db.sortedSetsRemoveRangeByScore([index], '-inf', now);
		return {
			access_token: access,
			token_type: 'bearer',
			expires_in: ACCESS_TOKEN_TTL_S,
			refresh_token: refresh,
			...(scopes.length ? { scope: scopes.join(' ') } : {}),
		};
	}

	/** A live access token and its grant. */
	async findAccess(token: string): Promise<(StoredToken & { grant: Grant }) | undefined> {
		const entry = await this.read<StoredToken>(`mcp:token:${hash(token)}`);
		if (!entry || entry.kind !== 'access' || entry.expiresAt < this.now()) return undefined;
		const grant = await this.getGrant(entry.grantId);
		return grant ? { ...entry, grant } : undefined;
	}

	/**
	 * Refresh tokens rotate: taking one uses it up — but only for the client it
	 * was issued to, so another client presenting it cannot burn it.
	 */
	async takeRefresh(token: string, clientId: string): Promise<(StoredToken & { grant: Grant }) | undefined> {
		const key = `mcp:token:${hash(token)}`;
		const peek = await this.read<StoredToken>(key);
		if (!peek || peek.kind !== 'refresh' || peek.clientId !== clientId || peek.expiresAt < this.now()) return undefined;
		const entry = await this.takeOnce<StoredToken>(key);
		if (!entry) return undefined;
		await this.db.sortedSetRemove(`mcp:grant:${entry.grantId}:tokens`, hash(token));
		const grant = await this.getGrant(entry.grantId);
		return grant ? { ...entry, grant } : undefined;
	}

	/** Revoke one token; a refresh token takes its whole grant with it. Returns the ended grant, if any. */
	async revoke(token: string, clientId: string): Promise<Grant | undefined> {
		const key = `mcp:token:${hash(token)}`;
		const entry = await this.read<StoredToken>(key);
		if (!entry || entry.clientId !== clientId) return undefined;
		if (entry.kind === 'refresh') return this.endGrant(entry.grantId);
		await this.db.delete(key);
		return undefined;
	}
}
