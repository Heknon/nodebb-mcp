/**
 * Signing in with a username and password — the way a browser does — and
 * keeping that session working without the user ever noticing.
 *
 * How NodeBB 4 behaves (observed on a live forum, see the skill's reference):
 *  - An anonymous `GET /api/config` issues an `express.sid` cookie and a
 *    `csrf_token`. `POST /api/v3/utilities/login` needs both, or it answers a
 *    plain-text 403 "Forbidden". Login replaces the cookie (a new session id);
 *    the CSRF token carries over, but we re-read it anyway.
 *  - With `remember: 'on'` the session lives `loginDays` (14 by default).
 *  - Cookie-session writes need `x-csrf-token`; without it: plain 403 "Forbidden".
 *  - A refused login is a text/html 403 whose body is a raw key:
 *    `[[error:invalid-login-credentials]]` (also for unknown users),
 *    `[[error:account-locked]]`, `[[error:ip-locked]]`.
 *  - Logins are rate-limited: more than `loginAttempts` (5) failures in an hour
 *    lock the account for `lockoutDuration` (60 min); more than
 *    `ipLoginAttempts` (20) attempts per hour — successful ones included — lock
 *    the caller's IP for an hour.
 *  - An expired or revoked session fails *silently* on reads: the old cookie is
 *    served as a guest. Page payloads say so (`loggedIn: false`); writes fail
 *    CSRF (plain 403); some routes answer 401.
 *
 * Hence the design:
 *  - sign in lazily, once, shared by concurrent requests;
 *  - on signs of a lost session, ask the forum (`check`); sign in again only
 *    when it says the session is gone, then retry the request once;
 *  - hold a refused sign-in for an hour (in this process and in the session
 *    file), so neither a long-running server nor restarts with the same wrong
 *    password can lock the account; back off after a sign-in that failed for
 *    any other reason, since every attempt counts toward the per-IP limit;
 *  - cache the session in a 0600 file so a new server process reuses it instead
 *    of logging in again (Claude starts a process per session; the per-IP limit
 *    is 20 an hour).
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { NodeBBError } from './errors.js';
import { writePrivateJson } from './files.js';
import { USER_AGENT } from './version.js';

export interface PasswordSessionOptions {
	url: string;
	username: string;
	/**
	 * The password, kept in memory so the session can sign in again by itself.
	 * Omitted for a session handed over from an OAuth sign-in: the server never
	 * keeps a user's password, so such a session cannot be renewed — when NodeBB
	 * ends it, it reports `session-ended` and the user signs in again.
	 */
	password?: string;
	/** Start from an existing signed-in session instead of signing in. */
	initial?: SessionState;
	/** Session cache path; undefined = keep the session in memory only. */
	sessionFile: string | undefined;
	timeoutMs: number;
	now?: () => number;
	/** Called after the session's cookies change (e.g. to persist them). */
	onChange?: (state: SessionState) => void;
	/** Called once when a password-less session is found to be over. */
	onEnded?: () => void;
}

/** A signed-in session, as it can be handed over or stored. */
export interface SessionState {
	cookies: Record<string, string>;
	csrf: string;
	uid: number;
}

type Refusal = 'credentials' | 'account-locked' | 'ip-locked' | 'no-session' | 'session-ended';

/** How long a refused sign-in is remembered — NodeBB's attempt counters last an hour. */
const REFUSAL_HOLD_MS = 60 * 60 * 1000;

interface SessionFile {
	version: 1;
	url: string;
	username: string;
	cookies?: Record<string, string>;
	csrf?: string;
	uid?: number;
	savedAt?: number;
	refused?: {
		reason: Refusal;
		message: string;
		until: number;
		/** scrypt of the refused password, so a corrected password is tried at once. */
		salt: string;
		hash: string;
	};
}

/** A sign-in the forum refused. Distinct from a network failure: retrying will not help. */
export class SignInError extends NodeBBError {
	readonly reason: Refusal;

	constructor(reason: Refusal, message: string, opts: { status?: number; forumMessage?: string } = {}) {
		// Its own kind: callers that read 'auth' as "not permitted" must not swallow it.
		super('sign-in', message, { ...opts, path: '/api/v3/utilities/login' });
		this.name = 'SignInError';
		this.reason = reason;
	}

	override get hint(): string {
		switch (this.reason) {
			case 'credentials':
				return 'Fix NODEBB_USERNAME / NODEBB_PASSWORD and restart the server.';
			case 'no-session':
				return 'Sign in once in a browser to finish any pending step, or use NODEBB_API_TOKEN instead.';
			case 'session-ended':
				return 'Reconnect this MCP server to sign in to the forum again.';
			default:
				return 'Wait for the lock to expire (an hour by default) or ask a forum administrator.';
		}
	}
}

function fingerprint(password: string, salt: string): string {
	return scryptSync(password, Buffer.from(salt, 'hex'), 32).toString('hex');
}

/** Does `password` match a stored fingerprint? A malformed record never matches. */
function matches(password: string, salt: unknown, hash: unknown): boolean {
	if (typeof salt !== 'string' || typeof hash !== 'string') return false;
	const expected = Buffer.from(hash, 'hex');
	const actual = Buffer.from(fingerprint(password, salt), 'hex');
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class PasswordSession {
	private readonly cookies = new Map<string, string>();
	private csrf: string | undefined;
	private signingIn: Promise<void> | undefined;
	private refusal: SignInError | undefined;
	/** When a held refusal lapses and signing in may be tried again. */
	private refusalUntil = 0;
	private loaded = false;
	private loading: Promise<void> | undefined;
	/** After a sign-in that failed for a transient reason: its error, held until `retryAt`. */
	private lastFailure: NodeBBError | undefined;
	private retryAt = 0;
	private retryDelayMs = 0;
	/** Whether the sign-in in progress has sent its login request (which the forum counts). */
	private loginSent = false;
	/** Bumped on every successful sign-in, so a stale "session lost" signal can be ignored. */
	private generation = 0;
	/** The uid the forum confirmed for this session; 0 until then. */
	uid = 0;
	/** Login requests sent by this process (diagnostics and tests). */
	logins = 0;
	/** When the forum last showed it honours this session (0 = never, this process). */
	private confirmedAt = 0;

	constructor(private readonly opts: PasswordSessionOptions) {
		if (opts.initial) {
			for (const [name, value] of Object.entries(opts.initial.cookies)) this.cookies.set(name, value);
			this.csrf = opts.initial.csrf;
			this.uid = opts.initial.uid;
			this.loaded = true;
			this.generation = 1;
			this.confirmedAt = this.now();
		}
	}

	/** The session as it can be handed over or stored (never includes a password). */
	exportState(): SessionState | undefined {
		if (!this.cookies.size || !this.csrf || !this.uid) return undefined;
		return { cookies: Object.fromEntries(this.cookies), csrf: this.csrf, uid: this.uid };
	}

	/** Sign in now (once), for a caller that needs the result rather than a lazy session. */
	async signInNow(): Promise<SessionState> {
		await this.ensure();
		const state = this.exportState();
		if (!state) throw new SignInError('no-session', `Signing in as "${this.opts.username}" produced no session.`);
		return state;
	}

	/** End the session on the forum (best effort) — used when access is revoked. */
	async signOut(): Promise<void> {
		if (!this.cookies.size) return;
		try {
			await this.send('POST', '/logout', {});
		} catch {
			// The forum may already have ended it; nothing more to do.
		}
		this.cookies.clear();
		this.csrf = undefined;
		this.uid = 0;
	}

	get username(): string {
		return this.opts.username;
	}

	get currentGeneration(): number {
		return this.generation;
	}

	/** The forum just showed it honours the session (a page payload with loggedIn: true). */
	confirm(): void {
		this.confirmedAt = this.now();
	}

	/** True when the session has not been confirmed within `maxAgeMs`. */
	needsConfirmation(maxAgeMs: number): boolean {
		return this.now() - this.confirmedAt >= maxAgeMs;
	}

	/** Headers that authenticate one request on this session. */
	headers(method: string): Record<string, string> {
		const headers: Record<string, string> = {};
		if (this.cookies.size) {
			headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
		}
		if (method !== 'GET' && this.csrf) headers['x-csrf-token'] = this.csrf;
		return headers;
	}

	/** Keep whatever cookies the forum (re)issued with a response. */
	absorb(response: Response): void {
		for (const raw of response.headers.getSetCookie?.() ?? []) {
			const [pair = '', ...attributes] = raw.split(';');
			const at = pair.indexOf('=');
			if (at <= 0) continue;
			const name = pair.slice(0, at).trim();
			const value = pair.slice(at + 1).trim();
			const expired = attributes.some(attr => /^\s*max-age\s*=\s*0\s*$/i.test(attr));
			if (!value || expired) this.cookies.delete(name);
			else this.cookies.set(name, value);
		}
	}

	/** Make sure a session is held, signing in if needed. Throws a remembered refusal. */
	async ensure(): Promise<void> {
		if (!this.loaded) await (this.loading ??= this.load());
		const refusal = this.heldRefusal();
		if (refusal) throw refusal;
		// A confirmed uid, not just a cookie: mid-sign-in (or after a failed one)
		// the cookie is an anonymous session's, and requests on it are a guest's.
		if (this.uid && this.cookies.size && this.csrf) return;
		if (this.opts.password === undefined) throw this.ended();
		await this.signIn();
	}

	/** The refusal still in force, if any; a lock or rejected password is held for an hour. */
	private heldRefusal(): SignInError | undefined {
		if (this.refusal && this.now() >= this.refusalUntil) this.refusal = undefined;
		return this.refusal;
	}

	/** A password-less session the forum no longer honours: latched, reported once. */
	private ended(): SignInError {
		if (this.refusal?.reason !== 'session-ended') {
			this.refusal = new SignInError(
				'session-ended',
				`The forum session for "${this.opts.username}" has ended (it expired or was signed out).`,
			);
			this.refusalUntil = Number.POSITIVE_INFINITY;
			this.opts.onEnded?.();
		}
		return this.refusal;
	}

	/**
	 * Ask the forum whether it still honours this session: true or false, or
	 * undefined when it cannot tell (unreachable, an error page, maintenance).
	 * A probe only — it keeps no cookie the forum sets, so it cannot disturb a
	 * sign-in running alongside it.
	 */
	async check(): Promise<boolean | undefined> {
		if (!this.uid || !this.cookies.size) return false;
		const generation = this.generation;
		try {
			const res = await fetch(`${this.opts.url}/api/config`, {
				headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...this.headers('GET') },
				signal: AbortSignal.timeout(this.opts.timeoutMs),
			});
			if (!res.ok) return undefined;
			const config = await res.json() as Raw;
			// Only NodeBB's own config answers the question — a numeric uid (0 for a
			// guest) and a CSRF token — not a maintenance page or a cached stub.
			if (!/^\d+$/.test(String(config.uid ?? '')) || typeof config.csrf_token !== 'string') return undefined;
			if (Number(config.uid) !== this.uid) return false;
			// Still ours. Take its current CSRF token (a cached one can be stale) —
			// unless a sign-in started or finished meanwhile: the answer is then about
			// the old session, and its token would break the new one.
			if (generation === this.generation && !this.signingIn) {
				this.confirm();
				if (config.csrf_token !== this.csrf) {
					this.csrf = config.csrf_token;
					await this.save();
					const state = this.exportState();
					if (state) this.opts.onChange?.(state);
				}
			}
			return true;
		} catch {
			return undefined;
		}
	}

	/**
	 * A request suggests the session stopped working (expired, revoked). Ask the
	 * forum: a 401 or a refused write can also come from a proxy, and ending a
	 * person's access or spending a sign-in on that would be wrong. Sign in
	 * again only when the forum confirms the session is gone — and not when a
	 * sign-in already happened since the failing request was sent.
	 *
	 * Returns whether the session changed (a new sign-in, or a fresh CSRF
	 * token), i.e. whether sending the failed request again can help.
	 */
	async renew(seenGeneration: number): Promise<boolean> {
		const refusal = this.heldRefusal();
		if (refusal) throw refusal;
		if (this.signingIn) {
			await this.signingIn;
			return true;
		}
		if (seenGeneration !== this.generation) return true;
		const csrf = this.csrf;
		const verdict = await this.check();
		if (this.signingIn) {
			await this.signingIn;
			return true;
		}
		if (seenGeneration !== this.generation) return true;
		// Still honoured, or the forum cannot say: keep the session.
		if (verdict !== false) return this.csrf !== csrf;
		if (this.opts.password === undefined) throw this.ended();
		this.cookies.clear();
		this.csrf = undefined;
		this.uid = 0;
		await this.signIn();
		return true;
	}

	private signIn(): Promise<void> {
		if (!this.signingIn && this.lastFailure && this.now() < this.retryAt) return Promise.reject(this.lastFailure);
		this.signingIn ??= this.doSignIn()
			.then(() => {
				this.lastFailure = undefined;
				this.retryDelayMs = 0;
			})
			.catch((err: unknown) => {
				// Never leave step 1's anonymous session behind as if it were ours.
				this.cookies.clear();
				this.csrf = undefined;
				this.uid = 0;
				// A refusal is held by refuse(). Any other failure after the login was
				// sent (a timeout, an error page) still counted toward the forum's per-IP
				// limit, so do not send another on every tool call: back off, doubling.
				if (!(err instanceof SignInError) && this.loginSent) {
					this.retryDelayMs = Math.min(Math.max(this.retryDelayMs * 2, 15_000), 10 * 60_000);
					this.retryAt = this.now() + this.retryDelayMs;
					const cause = err instanceof NodeBBError ? err : undefined;
					this.lastFailure = new NodeBBError(
						cause?.kind ?? 'network',
						`${err instanceof Error ? err.message : String(err)}. Not signing in again for ` +
							`${Math.round(this.retryDelayMs / 1000)}s: the forum limits sign-ins per hour.`,
						{ status: cause?.status, path: '/api/v3/utilities/login', cause: err },
					);
					throw this.lastFailure;
				}
				throw err;
			})
			.finally(() => {
				this.signingIn = undefined;
			});
		return this.signingIn;
	}

	private async doSignIn(): Promise<void> {
		this.cookies.clear();
		this.csrf = undefined;
		this.uid = 0;
		this.loginSent = false;

		// 1. An anonymous session and its CSRF token.
		const config = await this.json(await this.send('GET', '/api/config'));
		this.csrf = typeof config.csrf_token === 'string' ? config.csrf_token : undefined;

		// 2. Log in.
		this.logins += 1;
		this.loginSent = true;
		const res = await this.send('POST', '/api/v3/utilities/login', {
			username: this.opts.username,
			password: this.opts.password ?? '',
			remember: 'on',
		});
		if (!res.ok) {
			const body = (await res.text()).trim();
			const refusal = this.classify(res.status, body);
			if (refusal) {
				await this.refuse(refusal);
				throw refusal;
			}
			throw new NodeBBError(
				res.status >= 500 ? 'server' : 'bad-request',
				`Signing in as "${this.opts.username}" failed with HTTP ${res.status}`,
				{ status: res.status, path: '/api/v3/utilities/login' },
			);
		}

		// 3. Confirm the forum honours the session, and pick up its token.
		const after = await this.json(await this.send('GET', '/api/config'));
		if (typeof after.csrf_token === 'string') this.csrf = after.csrf_token;
		this.uid = Number.parseInt(String(after.uid ?? 0), 10) || 0;
		if (!this.uid) {
			const refusal = new SignInError(
				'no-session',
				`The forum accepted the password for "${this.opts.username}" but did not grant a session ` +
					'(an unfinished step such as two-factor authentication or a pending consent form).',
			);
			await this.refuse(refusal);
			throw refusal;
		}
		this.generation += 1;
		this.confirm();
		await this.save();
		const state = this.exportState();
		if (state) this.opts.onChange?.(state);
	}

	private classify(status: number, body: string): SignInError | undefined {
		const user = `"${this.opts.username}"`;
		if (body.includes('invalid-login-credentials')) {
			return new SignInError(
				'credentials',
				`The forum rejected the sign-in for ${user}: invalid username or password. These credentials ` +
					'will not be tried again for an hour, so restarts cannot lock the account.',
				{ status, forumMessage: body },
			);
		}
		if (body.includes('account-locked')) {
			return new SignInError(
				'account-locked',
				`The forum has locked ${user} after too many failed sign-ins. It unlocks by itself ` +
					'(after 60 minutes by default); not retrying until then.',
				{ status, forumMessage: body },
			);
		}
		if (body.includes('ip-locked')) {
			return new SignInError(
				'ip-locked',
				'The forum is refusing sign-ins from this machine\'s IP address after too many attempts ' +
					'in an hour. It clears by itself after an hour; not retrying until then.',
				{ status, forumMessage: body },
			);
		}
		return undefined;
	}

	/** One raw request on the session (sign-in traffic; bypasses the client's retry logic). */
	private async send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
		const headers: Record<string, string> = { accept: 'application/json', 'user-agent': USER_AGENT, ...this.headers(method) };
		if (body !== undefined) headers['content-type'] = 'application/json';
		let response: Response;
		try {
			response = await fetch(`${this.opts.url}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(this.opts.timeoutMs),
			});
		} catch (cause) {
			const aborted = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
			throw new NodeBBError(
				aborted ? 'timeout' : 'network',
				aborted ? `Signing in timed out after ${this.opts.timeoutMs}ms` : `Could not reach the forum at ${this.opts.url}`,
				{ path, cause },
			);
		}
		this.absorb(response);
		return response;
	}

	private async json(response: Response): Promise<Raw> {
		const text = await response.text();
		try {
			return (text ? JSON.parse(text) : {}) as Raw;
		} catch (cause) {
			throw new NodeBBError('bad-response', 'Malformed JSON from /api/config while signing in', {
				status: response.status,
				path: '/api/config',
				cause,
			});
		}
	}

	/* ------------------------------------------------------- session file */

	private now(): number {
		return this.opts.now?.() ?? Date.now();
	}

	/** Read the session file once; concurrent callers share the one read (see ensure()). */
	private async load(): Promise<void> {
		try {
			await this.loadFile();
		} finally {
			this.loaded = true;
		}
	}

	private async loadFile(): Promise<void> {
		if (!this.opts.sessionFile) return;
		let file: SessionFile;
		try {
			file = JSON.parse(await readFile(this.opts.sessionFile, 'utf8')) as SessionFile;
		} catch {
			return; // No file yet, or unreadable: sign in normally.
		}
		if (file.version !== 1 || file.url !== this.opts.url || file.username !== this.opts.username) return;

		const refused = file.refused;
		if (refused && refused.until > this.now()) {
			// A lock holds whatever the password; a rejected password only for that password.
			const samePassword = refused.reason !== 'credentials' || matches(this.opts.password ?? '', refused.salt, refused.hash);
			if (samePassword) {
				this.refusal = new SignInError(refused.reason, `${refused.message} (Remembered from an earlier attempt.)`);
				this.refusalUntil = refused.until;
				return;
			}
		}
		if (file.cookies && file.csrf) {
			for (const [name, value] of Object.entries(file.cookies)) this.cookies.set(name, value);
			this.csrf = file.csrf;
			this.uid = Number(file.uid) || 0;
		}
	}

	private async refuse(refusal: SignInError): Promise<void> {
		this.refusal = refusal;
		this.refusalUntil = this.now() + REFUSAL_HOLD_MS;
		this.cookies.clear();
		this.csrf = undefined;
		this.uid = 0;
		// "No session granted" (e.g. 2FA pending) is fixed outside this server and
		// attempts don't lock anything: hold it in this process only.
		if (refusal.reason === 'no-session') return;
		const salt = randomBytes(16).toString('hex');
		await this.write({
			version: 1,
			url: this.opts.url,
			username: this.opts.username,
			refused: {
				reason: refusal.reason,
				message: refusal.message,
				until: this.now() + REFUSAL_HOLD_MS,
				salt,
				hash: fingerprint(this.opts.password ?? '', salt),
			},
		});
	}

	private async save(): Promise<void> {
		await this.write({
			version: 1,
			url: this.opts.url,
			username: this.opts.username,
			cookies: Object.fromEntries(this.cookies),
			csrf: this.csrf,
			uid: this.uid,
			savedAt: this.now(),
		});
	}

	/** Atomic, owner-only write. A cache failure never breaks a request: the session still works in memory. */
	private async write(file: SessionFile): Promise<void> {
		if (this.opts.sessionFile) await writePrivateJson(this.opts.sessionFile, file);
	}
}

type Raw = Record<string, any>;
