/**
 * This server as its own OAuth 2.1 authorization server, with the forum as the
 * identity provider.
 *
 * A client (Claude Code, an IDE, the SDK) discovers us, registers itself
 * (dynamic client registration) and sends the person's browser to /authorize.
 * We show a sign-in page; the person signs in with their *forum* account, which
 * we check by signing in to the forum (NodeBB's real login — lockouts and all).
 * The forum session that sign-in creates becomes the person's grant: their MCP
 * tools act through it, as them, with exactly their forum permissions.
 *
 * Nothing outside the forum is involved, so it works air-gapped. The password
 * is used once and never stored; when the forum session ends (expiry, the
 * person signing it out from their account's sessions page, an admin), the
 * grant ends with it and the client is sent to sign in again.
 *
 * PKCE (S256) is required and checked by the SDK's token handler; codes are
 * single-use and live a minute; access tokens an hour; refresh tokens rotate.
 */

import type { Response } from 'express';

import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
	OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import type { Config } from '../config.js';
import { NodeBBError } from '../errors.js';
import { PasswordSession, SignInError } from '../session.js';
import { messagePage, signInPage } from './pages.js';
import type { Grant, OAuthStore } from './store.js';

export const SCOPE = 'forum';

/** What a person is told when the forum refuses their sign-in. */
function signInMessage(err: unknown): string {
	if (err instanceof SignInError) {
		switch (err.reason) {
			case 'credentials':
				return 'Wrong username or password.';
			case 'account-locked':
				return 'This account is locked after too many failed sign-ins. Try again later, or ask a forum administrator.';
			case 'ip-locked':
				return 'The forum is refusing sign-ins from this server for now (too many attempts). Try again in an hour.';
			case 'no-session':
				return 'The forum needs an extra step for this account (for example two-factor authentication), which this sign-in cannot do.';
			default:
				return err.message;
		}
	}
	if (err instanceof NodeBBError && (err.kind === 'network' || err.kind === 'timeout')) {
		return 'The forum could not be reached. Try again in a moment.';
	}
	return 'Signing in failed. Try again.';
}

export class ForumOAuthProvider implements OAuthServerProvider {
	constructor(
		private readonly config: Config,
		private readonly store: OAuthStore,
		private readonly forumName: string,
		/** A grant's forum session ended or was revoked: drop anything holding it. */
		private readonly onGrantEnded: (grant: Grant) => void = () => {},
	) {}

	get clientsStore(): OAuthRegisteredClientsStore {
		return {
			getClient: clientId => this.store.getClient(clientId),
			registerClient: client => this.store.registerClient(client),
		};
	}

	async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
		const pending = this.store.addPending({
			clientId: client.client_id,
			clientName: client.client_name,
			redirectUri: params.redirectUri,
			codeChallenge: params.codeChallenge,
			state: params.state,
			scopes: params.scopes?.length ? params.scopes : [SCOPE],
			resource: params.resource?.href,
		});
		this.renderSignIn(res, pending.id);
	}

	/** Render (or re-render, with an error) the sign-in page for a pending request. */
	renderSignIn(res: Response, requestId: string, extra: { username?: string; error?: string } = {}, status = 200): void {
		const pending = this.store.getPending(requestId);
		if (!pending) {
			res.status(400).type('html').send(messagePage(
				'This sign-in link has expired',
				'Start connecting again from your MCP client.',
			));
			return;
		}
		let redirectHost = pending.redirectUri;
		try {
			redirectHost = new URL(pending.redirectUri).host;
		} catch {
			// Shown as given.
		}
		res
			.status(status)
			.set('Cache-Control', 'no-store')
			.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
			.set('X-Frame-Options', 'DENY')
			.type('html')
			.send(signInPage({
				forumName: this.forumName,
				clientName: pending.clientName || 'An MCP client',
				redirectHost,
				requestId,
				...extra,
			}));
	}

	/**
	 * The sign-in form was submitted. On success: a grant, a one-time code, and a
	 * redirect back to the client. On refusal: the page again, with the reason.
	 */
	async completeSignIn(
		res: Response,
		form: { request?: string; username?: string; password?: string; action?: string },
	): Promise<void> {
		const pending = form.request ? this.store.getPending(form.request) : undefined;
		if (!pending) {
			this.renderSignIn(res, form.request ?? '');
			return;
		}
		const back = new URL(pending.redirectUri);
		if (pending.state) back.searchParams.set('state', pending.state);

		if (form.action === 'deny') {
			this.store.cancelPending(pending.id);
			back.searchParams.set('error', 'access_denied');
			back.searchParams.set('error_description', 'The person cancelled signing in.');
			res.redirect(302, back.href);
			return;
		}

		const username = (form.username ?? '').trim();
		const password = form.password ?? '';
		if (!username || !password) {
			this.renderSignIn(res, pending.id, { username, error: 'Enter your forum username and password.' }, 400);
			return;
		}

		// The forum checks the password: NodeBB's login, rate limits and all. The
		// session it creates is what the person's tools will act through.
		const session = new PasswordSession({
			url: this.config.url,
			username,
			password,
			sessionFile: undefined,
			timeoutMs: this.config.timeoutMs,
		});
		let state;
		try {
			state = await session.signInNow();
		} catch (err) {
			this.renderSignIn(res, pending.id, { username, error: signInMessage(err) }, 401);
			return;
		}

		// The forum's own name for the account, not what was typed.
		const canonical = await this.lookupUsername(state.uid, username);
		const code = this.store.completeSignIn(pending, { uid: state.uid, username: canonical, session: state });
		back.searchParams.set('code', code);
		res.redirect(302, back.href);
	}

	private async lookupUsername(uid: number, typed: string): Promise<string> {
		try {
			const res = await fetch(`${this.config.url}/api/v3/users/${uid}`, { signal: AbortSignal.timeout(this.config.timeoutMs) });
			const body = await res.json() as { response?: { username?: string } };
			return body.response?.username || typed;
		} catch {
			return typed;
		}
	}

	async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
		const code = this.store.peekCode(authorizationCode);
		if (!code || code.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
		return code.codeChallenge;
	}

	async exchangeAuthorizationCode(
		client: OAuthClientInformationFull,
		authorizationCode: string,
		_codeVerifier?: string,
		redirectUri?: string,
		resource?: URL,
	): Promise<OAuthTokens> {
		// The SDK has already checked the PKCE verifier against the challenge.
		const code = this.store.takeCode(authorizationCode);
		if (!code || code.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
		if (redirectUri && redirectUri !== code.redirectUri) throw new InvalidGrantError('redirect_uri does not match');
		if (resource && code.resource && resource.href !== code.resource) throw new InvalidGrantError('resource does not match');
		if (!this.store.liveGrant(code.grantId)) throw new InvalidGrantError('The sign-in is no longer valid');
		return this.store.issueTokens(code.grantId, client.client_id, code.scopes, code.resource);
	}

	async exchangeRefreshToken(
		client: OAuthClientInformationFull,
		refreshToken: string,
		_scopes?: string[],
		resource?: URL,
	): Promise<OAuthTokens> {
		const entry = this.store.takeRefresh(refreshToken);
		if (!entry || entry.clientId !== client.client_id) {
			throw new InvalidGrantError('Invalid refresh token — sign in again');
		}
		if (resource && entry.resource && resource.href !== entry.resource) throw new InvalidGrantError('resource does not match');
		// Refreshing is where a dead forum session is noticed cheaply: no session, no new token.
		if (!(await this.forumSessionAlive(entry.grant))) {
			const ended = this.store.endGrant(entry.grant.id);
			if (ended) this.onGrantEnded(ended);
			throw new InvalidGrantError('The forum session has ended — sign in again');
		}
		return this.store.issueTokens(entry.grant.id, client.client_id, entry.scopes, entry.resource);
	}

	async verifyAccessToken(token: string): Promise<AuthInfo> {
		const entry = this.store.findAccess(token);
		if (!entry) throw new InvalidTokenError('Invalid, expired or revoked access token');
		return {
			token,
			clientId: entry.clientId,
			scopes: entry.scopes,
			expiresAt: entry.expiresAt,
			...(entry.resource ? { resource: new URL(entry.resource) } : {}),
			extra: { grantId: entry.grant.id, uid: entry.grant.uid, username: entry.grant.username },
		};
	}

	async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
		const ended = this.store.revoke(request.token, client.client_id);
		if (!ended) return;
		this.onGrantEnded(ended);
		// Revoking access signs the forum session out too, so it leaves the
		// person's sessions list rather than lingering.
		const session = new PasswordSession({
			url: this.config.url,
			username: ended.username,
			initial: ended.session,
			sessionFile: undefined,
			timeoutMs: this.config.timeoutMs,
		});
		await session.signOut();
	}

	/** Does the forum still honour this grant's session? */
	private async forumSessionAlive(grant: Grant): Promise<boolean> {
		try {
			const cookie = Object.entries(grant.session.cookies).map(([name, value]) => `${name}=${value}`).join('; ');
			const res = await fetch(`${this.config.url}/api/config`, {
				headers: { cookie, accept: 'application/json' },
				signal: AbortSignal.timeout(this.config.timeoutMs),
			});
			const config = await res.json() as { uid?: number | string };
			return Number(config.uid) === grant.uid;
		} catch {
			// The forum is unreachable: not proof the session ended; let the tools report it.
			return true;
		}
	}
}
