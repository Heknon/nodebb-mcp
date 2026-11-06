/**
 * The forum as an OAuth 2.1 authorization server for MCP clients.
 *
 * A client (Claude Code, an IDE) registers itself and sends the person's browser
 * to /api/mcp/oauth/authorize. They land on the forum's own "Connect" page, signed
 * in the way they always sign in (password, SSO, two-factor — whatever the
 * forum uses), and allow or refuse. Allowing yields a one-time code; redeeming it
 * creates the grant: a NodeBB API token for that person (visible in ACP → API
 * Access), through which their tools act with exactly their forum permissions.
 * No password ever passes through here.
 *
 * Access ends when the person disconnects the app (their connections page), an
 * administrator revokes it (ACP → Plugins → MCP, or deletes the API token), the
 * client revokes its refresh token, the same app connects again (replacing it),
 * or nobody has used it for 90 days.
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

import type { Grant, PendingAuthorization, PluginStore } from './store.js';

export const SCOPE = 'forum';

// OAuth error messages can end up in a WWW-Authenticate header: keep them plain ASCII
// (an em dash there makes Node refuse to send the response at all).

/** NodeBB's API-token functions (src/api/utils.js → tokens). */
export interface NodeBBTokens {
	generate(args: { uid: number; description: string }): Promise<string>;
	get(token: string): Promise<{ uid?: number | string } | null | undefined>;
	delete(token: string): Promise<void>;
}

export class PluginOAuthProvider implements OAuthServerProvider {
	constructor(
		private readonly store: PluginStore,
		private readonly tokens: NodeBBTokens,
		/** The forum's Connect page, where the person allows or refuses. */
		private readonly connectUrl: string,
		/** A grant ended: drop anything built for it. */
		private readonly onGrantEnded: (grant: Grant) => void = () => {},
	) {}

	get clientsStore(): OAuthRegisteredClientsStore {
		return {
			getClient: clientId => this.store.getClient(clientId),
			registerClient: client => this.store.registerClient(client),
		};
	}

	async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
		const pending = await this.store.addPending({
			clientId: client.client_id,
			clientName: client.client_name,
			redirectUri: params.redirectUri,
			codeChallenge: params.codeChallenge,
			state: params.state,
			scopes: params.scopes?.length ? params.scopes : [SCOPE],
			resource: params.resource?.href,
		});
		res.redirect(302, `${this.connectUrl}?request=${encodeURIComponent(pending.id)}`);
	}

	/** What the Connect page shows; undefined when the request expired or was used. */
	pending(requestId: string): Promise<PendingAuthorization | undefined> {
		return this.store.getPending(requestId);
	}

	/**
	 * The person answered on the Connect page. Allowing issues a one-time code
	 * (the connection itself is made when the client redeems it); either way,
	 * the answer is where to send the browser.
	 */
	async decide(requestId: string, person: { uid: number; username: string }, allow: boolean): Promise<URL | undefined> {
		const pending = await this.store.takePending(requestId);
		if (!pending) return undefined;
		const back = new URL(pending.redirectUri);
		if (pending.state) back.searchParams.set('state', pending.state);
		if (!allow) {
			back.searchParams.set('error', 'access_denied');
			back.searchParams.set('error_description', 'The person declined to connect.');
			return back;
		}
		const code = await this.store.addCode({
			uid: person.uid,
			username: person.username,
			clientId: pending.clientId,
			clientName: pending.clientName || 'An MCP client',
			redirectUri: pending.redirectUri,
			codeChallenge: pending.codeChallenge,
			scopes: pending.scopes,
			resource: pending.resource,
		});
		back.searchParams.set('code', code);
		return back;
	}

	/** End a grant: its tokens, its NodeBB API token, anything built for it. */
	async endGrant(id: string): Promise<Grant | undefined> {
		const grant = await this.store.endGrant(id);
		if (!grant) return undefined;
		await this.tokens.delete(grant.nodebbToken).catch(() => {});
		this.onGrantEnded(grant);
		return grant;
	}

	/** The grant's NodeBB token still exists (an administrator may have deleted it). */
	private async stillHonoured(grant: Grant): Promise<boolean> {
		const token = await this.tokens.get(grant.nodebbToken);
		return Boolean(token) && Number(token?.uid) === grant.uid;
	}

	async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
		const code = await this.store.peekCode(authorizationCode);
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
		const code = await this.store.takeCode(authorizationCode);
		if (!code || code.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
		if (redirectUri && redirectUri !== code.redirectUri) throw new InvalidGrantError('redirect_uri does not match');
		if (resource && code.resource && resource.href !== code.resource) throw new InvalidGrantError('resource does not match');
		// Connecting the same app again replaces its earlier connection (and token).
		const earlier = (await this.store.listGrants(code.uid)).filter(grant => grant.clientId === client.client_id);
		await Promise.all(earlier.map(grant => this.endGrant(grant.id)));
		const nodebbToken = await this.tokens.generate({
			uid: code.uid,
			description: `MCP: ${code.clientName} (${code.username})`,
		});
		const grant = await this.store.createGrant({
			uid: code.uid,
			username: code.username,
			clientId: client.client_id,
			clientName: code.clientName,
			nodebbToken,
		});
		return this.store.issueTokens(grant.id, client.client_id, code.scopes, code.resource);
	}

	async exchangeRefreshToken(
		client: OAuthClientInformationFull,
		refreshToken: string,
		_scopes?: string[],
		resource?: URL,
	): Promise<OAuthTokens> {
		const entry = await this.store.takeRefresh(refreshToken, client.client_id);
		if (!entry) throw new InvalidGrantError('Invalid refresh token; connect again');
		if (resource && entry.resource && resource.href !== entry.resource) throw new InvalidGrantError('resource does not match');
		if (!(await this.stillHonoured(entry.grant))) {
			await this.endGrant(entry.grant.id);
			throw new InvalidGrantError('This connection was revoked on the forum; connect again');
		}
		return this.store.issueTokens(entry.grant.id, client.client_id, entry.scopes, entry.resource);
	}

	async verifyAccessToken(token: string): Promise<AuthInfo> {
		const entry = await this.store.findAccess(token);
		if (!entry) throw new InvalidTokenError('Invalid, expired or revoked access token');
		if (!(await this.stillHonoured(entry.grant))) {
			await this.endGrant(entry.grant.id);
			throw new InvalidTokenError('This connection was revoked on the forum; connect again');
		}
		await this.store.touchGrant(entry.grant);
		return {
			token,
			clientId: entry.clientId,
			scopes: entry.scopes,
			expiresAt: Math.floor(entry.expiresAt / 1000),
			...(entry.resource ? { resource: new URL(entry.resource) } : {}),
			// The verified grant rides along, so the request handler need not read it again.
			extra: { grantId: entry.grant.id, uid: entry.grant.uid, username: entry.grant.username, grant: entry.grant },
		};
	}

	async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
		const ended = await this.store.revoke(request.token, client.client_id);
		if (!ended) return;
		await this.tokens.delete(ended.nodebbToken).catch(() => {});
		this.onGrantEnded(ended);
	}
}
