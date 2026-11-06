/**
 * State for the OAuth authorization server.
 *
 * What is kept, and where:
 *  - registered clients (dynamic client registration) — persisted;
 *  - grants: one person's authorization of one client, owning that person's
 *    signed-in forum session (cookie + CSRF token; never a password) — persisted;
 *  - access and refresh tokens — persisted as SHA-256 hashes only, so the
 *    state file cannot be replayed as credentials for this server;
 *  - pending sign-ins and authorization codes — memory only, minutes-lived.
 *
 * The state file is written atomically with owner-only permissions; it holds
 * forum sessions, which are equivalent to being signed in.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

import type { SessionState } from '../session.js';

export const ACCESS_TOKEN_TTL_S = 60 * 60;
const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;

export interface PendingSignIn {
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

interface AuthorizationCode {
	grantId: string;
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	scopes: string[];
	resource?: string;
	expiresAt: number;
}

export interface Grant {
	id: string;
	clientId: string;
	uid: number;
	username: string;
	session: SessionState;
	createdAt: number;
	/** Set when the forum session ended or access was revoked. */
	endedAt?: number;
}

interface StoredToken {
	kind: 'access' | 'refresh';
	grantId: string;
	clientId: string;
	scopes: string[];
	resource?: string;
	/** Epoch seconds; access tokens only. */
	expiresAt?: number;
}

interface StateFile {
	version: 1;
	forum: string;
	clients: Record<string, OAuthClientInformationFull>;
	grants: Record<string, Grant>;
	tokens: Record<string, StoredToken>;
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

export class OAuthStore {
	private clients = new Map<string, OAuthClientInformationFull>();
	private grants = new Map<string, Grant>();
	private tokens = new Map<string, StoredToken>();
	private pending = new Map<string, PendingSignIn>();
	private codes = new Map<string, AuthorizationCode>();
	private writing: Promise<void> = Promise.resolve();

	constructor(
		private readonly forumUrl: string,
		private readonly file: string | undefined,
		private readonly now: () => number = Date.now,
	) {}

	async load(): Promise<void> {
		if (!this.file) return;
		let state: StateFile;
		try {
			state = JSON.parse(await readFile(this.file, 'utf8')) as StateFile;
		} catch {
			return; // First start, or unreadable: begin empty.
		}
		// A state file for another forum is never reused.
		if (state.version !== 1 || state.forum !== this.forumUrl) return;
		this.clients = new Map(Object.entries(state.clients ?? {}));
		this.grants = new Map(Object.entries(state.grants ?? {}));
		this.tokens = new Map(Object.entries(state.tokens ?? {}));
	}

	/* ---------------------------------------------------------- clients */

	getClient(clientId: string): OAuthClientInformationFull | undefined {
		return this.clients.get(clientId);
	}

	registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): OAuthClientInformationFull {
		const full: OAuthClientInformationFull = {
			...client,
			client_id: randomUUID(),
			client_id_issued_at: Math.floor(this.now() / 1000),
		};
		this.clients.set(full.client_id, full);
		this.persist();
		return full;
	}

	/* ---------------------------------------------------------- sign-in */

	addPending(request: Omit<PendingSignIn, 'id' | 'expiresAt'>): PendingSignIn {
		this.sweep();
		const pending: PendingSignIn = { ...request, id: secret(), expiresAt: this.now() + PENDING_TTL_MS };
		this.pending.set(pending.id, pending);
		return pending;
	}

	getPending(id: string): PendingSignIn | undefined {
		const pending = this.pending.get(id);
		if (!pending || pending.expiresAt < this.now()) return undefined;
		return pending;
	}

	/** Consume a pending sign-in: a grant for the user, and a one-time code for the client. */
	completeSignIn(pending: PendingSignIn, user: { uid: number; username: string; session: SessionState }): string {
		this.pending.delete(pending.id);
		const grant: Grant = {
			id: randomUUID(),
			clientId: pending.clientId,
			uid: user.uid,
			username: user.username,
			session: user.session,
			createdAt: this.now(),
		};
		this.grants.set(grant.id, grant);
		const code = secret();
		this.codes.set(code, {
			grantId: grant.id,
			clientId: pending.clientId,
			redirectUri: pending.redirectUri,
			codeChallenge: pending.codeChallenge,
			scopes: pending.scopes,
			resource: pending.resource,
			expiresAt: this.now() + CODE_TTL_MS,
		});
		this.persist();
		return code;
	}

	cancelPending(id: string): void {
		this.pending.delete(id);
	}

	/* ------------------------------------------------------------ codes */

	peekCode(code: string): AuthorizationCode | undefined {
		const entry = this.codes.get(code);
		return entry && entry.expiresAt >= this.now() ? entry : undefined;
	}

	/** Codes are single-use: taking one deletes it. */
	takeCode(code: string): AuthorizationCode | undefined {
		const entry = this.peekCode(code);
		this.codes.delete(code);
		return entry;
	}

	/* ----------------------------------------------------------- tokens */

	issueTokens(grantId: string, clientId: string, scopes: string[], resource?: string): IssuedTokens {
		const access = secret();
		const refresh = secret();
		const expiresAt = Math.floor(this.now() / 1000) + ACCESS_TOKEN_TTL_S;
		this.tokens.set(hash(access), { kind: 'access', grantId, clientId, scopes, resource, expiresAt });
		this.tokens.set(hash(refresh), { kind: 'refresh', grantId, clientId, scopes, resource });
		this.persist();
		return {
			access_token: access,
			token_type: 'bearer',
			expires_in: ACCESS_TOKEN_TTL_S,
			refresh_token: refresh,
			...(scopes.length ? { scope: scopes.join(' ') } : {}),
		};
	}

	/** A live access token: known, unexpired, and its grant not ended. */
	findAccess(token: string): (StoredToken & { grant: Grant }) | undefined {
		const entry = this.tokens.get(hash(token));
		if (!entry || entry.kind !== 'access') return undefined;
		if ((entry.expiresAt ?? 0) * 1000 < this.now()) return undefined;
		const grant = this.liveGrant(entry.grantId);
		return grant ? { ...entry, grant } : undefined;
	}

	/** Refresh tokens rotate: taking one deletes it. */
	takeRefresh(token: string): (StoredToken & { grant: Grant }) | undefined {
		const key = hash(token);
		const entry = this.tokens.get(key);
		if (!entry || entry.kind !== 'refresh') return undefined;
		this.tokens.delete(key);
		this.persist();
		const grant = this.liveGrant(entry.grantId);
		return grant ? { ...entry, grant } : undefined;
	}

	/** Revoke one token; revoking a refresh token ends its whole grant. Returns the ended grant, if any. */
	revoke(token: string, clientId: string): Grant | undefined {
		const key = hash(token);
		const entry = this.tokens.get(key);
		if (!entry || entry.clientId !== clientId) return undefined;
		this.tokens.delete(key);
		let ended: Grant | undefined;
		if (entry.kind === 'refresh') ended = this.endGrant(entry.grantId);
		this.persist();
		return ended;
	}

	/* ----------------------------------------------------------- grants */

	liveGrant(id: string): Grant | undefined {
		const grant = this.grants.get(id);
		return grant && !grant.endedAt ? grant : undefined;
	}

	updateGrantSession(id: string, session: SessionState): void {
		const grant = this.grants.get(id);
		if (!grant) return;
		grant.session = session;
		this.persist();
	}

	/** The forum session is over (expired, signed out, revoked): every token of the grant dies with it. */
	endGrant(id: string): Grant | undefined {
		const grant = this.grants.get(id);
		if (!grant || grant.endedAt) return undefined;
		grant.endedAt = this.now();
		for (const [key, token] of this.tokens) if (token.grantId === id) this.tokens.delete(key);
		this.persist();
		return grant;
	}

	/* ------------------------------------------------------- housekeeping */

	private sweep(): void {
		const now = this.now();
		for (const [id, pending] of this.pending) if (pending.expiresAt < now) this.pending.delete(id);
		for (const [code, entry] of this.codes) if (entry.expiresAt < now) this.codes.delete(code);
		// Ended grants keep no session; drop them after a day.
		for (const [id, grant] of this.grants) {
			if (grant.endedAt && now - grant.endedAt > 24 * 60 * 60 * 1000) this.grants.delete(id);
		}
	}

	/** Serialized, atomic, owner-only writes. A failed write never breaks a request. */
	private persist(): void {
		if (!this.file) return;
		const file = this.file;
		const snapshot: StateFile = {
			version: 1,
			forum: this.forumUrl,
			clients: Object.fromEntries(this.clients),
			grants: Object.fromEntries(
				[...this.grants].map(([id, grant]) => [id, grant.endedAt ? { ...grant, session: { cookies: {}, csrf: '', uid: grant.uid } } : grant]),
			),
			tokens: Object.fromEntries(this.tokens),
		};
		this.writing = this.writing.then(async () => {
			try {
				await mkdir(dirname(file), { recursive: true, mode: 0o700 });
				const tmp = `${file}.${process.pid}.tmp`;
				await writeFile(tmp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
				await rename(tmp, file);
			} catch {
				// State stays correct in memory; the next write retries.
			}
		});
	}

	/** Wait for pending writes (tests, shutdown). */
	flush(): Promise<void> {
		return this.writing;
	}
}
