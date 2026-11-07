/**
 * Connection diagnostics for the ACP "Test connection" button.
 *
 * Tools reach the forum over HTTP from inside the forum process: first the
 * loopback address (skips the reverse proxy), then the public URL. This checks
 * each step separately, so an administrator can see which one fails and why,
 * without guessing from a tool's one-line error.
 */

import { lookup } from 'node:dns/promises';

export type Status = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
	id: string;
	title: string;
	status: Status;
	/** One line: what was found. */
	summary: string;
	/** What to do about it, when it is not ok. */
	advice?: string;
	/** Raw facts (addresses, status codes, error codes), for the copyable report. */
	details?: Record<string, unknown>;
}

export interface Report {
	at: string;
	verdict: Status;
	/** One line an administrator reads first. */
	headline: string;
	/** The address tools will use, as far as this run can tell. */
	route: 'loopback' | 'public' | 'none';
	checks: Check[];
}

export interface DiagnosticsInput {
	url: string;
	apiUrl: string;
	relativePath: string;
	endpoint: string;
	nconf: { get(key: string): any };
	trustProxy: unknown;
	timeoutMs?: number;
}

interface Probe {
	ok: boolean;
	status?: number;
	ms: number;
	contentType?: string;
	body?: string;
	json?: any;
	headers?: Record<string, string>;
	error?: { name: string; message: string; code?: string; chain: string[] };
}

/** Every message and code in an error's cause chain (fetch hides the useful one a level down). */
function unwrap(err: unknown): Probe['error'] {
	const chain: string[] = [];
	let code: string | undefined;
	let cur: any = err;
	for (let depth = 0; cur && depth < 5; depth += 1) {
		const part = [cur.code, cur.message].filter(Boolean).join(': ');
		if (part) chain.push(part);
		code ??= cur.code;
		cur = cur.cause;
	}
	const top = err as Error;
	return { name: top?.name ?? 'Error', message: top?.message ?? String(err), code, chain };
}

async function probe(url: string, timeoutMs: number, init: RequestInit = {}): Promise<Probe> {
	const started = Date.now();
	try {
		const res = await fetch(url, {
			redirect: 'manual',
			...init,
			headers: { accept: 'application/json', 'user-agent': 'nodebb-plugin-mcp/diagnostics', ...(init.headers ?? {}) },
			signal: AbortSignal.timeout(timeoutMs),
		});
		const body = (await res.text()).slice(0, 4000);
		const contentType = res.headers.get('content-type') ?? '';
		let json: any;
		if (contentType.includes('json')) {
			try { json = JSON.parse(body); } catch { /* reported as not-JSON below */ }
		}
		const headers: Record<string, string> = {};
		for (const key of ['location', 'server', 'www-authenticate', 'x-powered-by', 'via']) {
			const value = res.headers.get(key);
			if (value) headers[key] = value;
		}
		return { ok: res.ok, status: res.status, ms: Date.now() - started, contentType, body, json, headers };
	} catch (err) {
		return { ok: false, ms: Date.now() - started, error: unwrap(err) };
	}
}

/** Plain-language reason and fix for a low-level connection error. */
function explain(error: NonNullable<Probe['error']>, where: 'loopback' | 'public'): string {
	const code = error.code ?? '';
	const text = error.chain.join(' | ');
	if (error.name === 'TimeoutError' || error.name === 'AbortError') {
		return where === 'public'
			? 'Nothing answered in time. The forum host may not be able to reach its own public address (no hairpin NAT, a firewall, or the domain resolving to an address only the outside world can route). Point the domain at the proxy\'s internal address from the forum host (e.g. an /etc/hosts or Docker extra_hosts entry), or fix the loopback check above so the public route is never needed.'
			: 'Nothing answered in time on the loopback address: something else may be listening on that port, or a firewall drops local traffic.';
	}
	if (code === 'ECONNREFUSED') {
		return where === 'loopback'
			? 'Nothing is listening at this address inside the forum process\'s network. NodeBB is listening on a different port or interface than config.json says (check "port" and "bind_address", and any PORT environment variable), or it listens on a unix socket.'
			: 'The public address resolves, but nothing accepts connections there from the forum host. From inside a container the domain often resolves to the host\'s public IP, which the container cannot reach back through. Map the domain to the reverse proxy\'s internal address for the forum host.';
	}
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
		return 'The forum host cannot resolve this name. Check DNS inside the forum\'s container or server, or add the name to its hosts file.';
	}
	if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
		return 'The connection was opened and then dropped. Often a proxy or firewall that only accepts certain clients, or plain HTTP sent to an HTTPS port (or the reverse).';
	}
	if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
		return 'No network route from the forum host to this address: the container may have no outbound network, or IPv6 is advertised but not routed.';
	}
	if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|SSL|certificate/i.test(code + text)) {
		return 'TLS verification failed: the certificate is self-signed, issued by a private CA, for another name, or the chain is incomplete. Install the CA for Node with NODE_EXTRA_CA_CERTS=/path/ca.pem in the forum\'s environment, or serve the full chain.';
	}
	if (/bad port/i.test(text)) {
		return 'Node refuses to fetch this port (it is on the browser\'s blocked-ports list). Run NodeBB on another port.';
	}
	return 'The request failed before any HTTP response. The error chain below has the details.';
}

function looksLikeConfig(p: Probe): boolean {
	return Boolean(p.json && typeof p.json === 'object' && ('relative_path' in p.json || 'siteTitle' in p.json));
}

/** What a reachable but wrong answer means. */
function explainResponse(p: Probe, where: 'loopback' | 'public'): string {
	if (p.status && p.status >= 300 && p.status < 400) {
		return `Redirected to ${p.headers?.location ?? '(no location)'}. ${where === 'public'
			? 'The configured url probably uses the wrong scheme or host (http vs https, www vs bare domain): set NodeBB\'s "url" to the exact address people use.'
			: 'NodeBB redirects even on loopback: usually its "url" scheme or host differs from what it serves, or a plugin forces https.'}`;
	}
	if (p.status === 502 || p.status === 503 || p.status === 504) {
		return 'The reverse proxy answered but could not reach NodeBB behind it.';
	}
	if (p.status === 403 || p.status === 401) {
		return 'Something in front of NodeBB refused the request (a WAF, basic auth, an IP allowlist, or a bot challenge such as Cloudflare). Allow the forum host\'s own address through, or rely on the loopback route.';
	}
	if (p.status === 404) {
		return 'Not found: the url\'s path (relative_path) probably does not match where NodeBB is mounted.';
	}
	if (p.ok && !looksLikeConfig(p)) {
		return `Answered ${p.status} with ${p.contentType || 'no content type'}, not NodeBB's JSON: something other than NodeBB served it (a proxy error page, a parked domain, a different app on that port).`;
	}
	return `HTTP ${p.status}.`;
}

function probeCheck(id: string, title: string, url: string, p: Probe, where: 'loopback' | 'public', relativePath: string): Check {
	const details: Record<string, unknown> = { url, ms: p.ms };
	if (p.status !== undefined) Object.assign(details, { status: p.status, contentType: p.contentType, headers: p.headers });
	if (p.error) details.error = p.error;
	if (p.error) {
		return { id, title, status: 'fail', summary: `No HTTP response: ${p.error.code ?? p.error.name}${p.error.chain.length ? ` (${p.error.chain.at(-1)})` : ''}`, advice: explain(p.error, where), details };
	}
	if (!p.ok || !looksLikeConfig(p)) {
		if (!looksLikeConfig(p) && p.body) details.bodyStart = p.body.slice(0, 300);
		return { id, title, status: 'fail', summary: `Reached, but HTTP ${p.status}${looksLikeConfig(p) ? '' : ', not NodeBB'}`, advice: explainResponse(p, where), details };
	}
	const served = String(p.json.relative_path ?? '');
	details.siteTitle = p.json.siteTitle;
	details.version = p.json.version;
	if (served !== relativePath) {
		return { id, title, status: 'warn', summary: `NodeBB answered in ${p.ms} ms, but under relative_path "${served}", not "${relativePath}"`, advice: 'Another NodeBB, or a different mount point, answered here. Check "url" in config.json.', details };
	}
	return { id, title, status: 'ok', summary: `NodeBB "${p.json.siteTitle ?? ''}" answered in ${p.ms} ms`, details };
}

export async function runDiagnostics(input: DiagnosticsInput): Promise<Report> {
	const { url, apiUrl, relativePath, nconf } = input;
	const timeoutMs = input.timeoutMs ?? 5000;
	const checks: Check[] = [];

	// 1. Configuration as this process sees it.
	const env = (k: string) => process.env[k] ?? process.env[k.toLowerCase()];
	const proxyEnv = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].filter(k => env(k));
	const config = {
		url,
		relative_path: relativePath,
		port: nconf.get('port'),
		bind_address: nconf.get('bind_address') ?? '(all interfaces)',
		ssl: Boolean(nconf.get('ssl')),
		trust_proxy: input.trustProxy,
		loopbackUrl: apiUrl,
		node: process.version,
		pid: process.pid,
		proxyEnv: proxyEnv.length ? Object.fromEntries(proxyEnv.map(k => [k, env(k)])) : undefined,
		NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY,
		NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
		NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
	};
	const configAdvice: string[] = [];
	if (apiUrl === url) configAdvice.push(nconf.get('ssl')
		? 'NodeBB terminates TLS itself, so there is no plain loopback route: tools always use the public URL.'
		: 'No numeric port in the config, so there is no loopback route: tools always use the public URL.');
	if (proxyEnv.length && process.env.NODE_USE_ENV_PROXY) configAdvice.push('An HTTP proxy is configured for Node; make sure NO_PROXY covers 127.0.0.1 and the forum\'s own domain.');
	if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') configAdvice.push('NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate checks for the whole forum process. Prefer NODE_EXTRA_CA_CERTS.');
	let parsed: URL | undefined;
	try { parsed = new URL(url); } catch { /* reported below */ }
	if (!parsed) {
		checks.push({ id: 'config', title: 'Forum configuration', status: 'fail', summary: `The configured url "${url}" is not a valid URL`, advice: 'Set "url" in config.json to the address people use, e.g. https://forum.example.com.', details: config });
	} else {
		checks.push({
			id: 'config',
			title: 'Forum configuration',
			status: configAdvice.length ? 'warn' : 'ok',
			summary: `url ${url}, port ${String(config.port ?? '?')}, loopback ${apiUrl === url ? '(none)' : apiUrl}`,
			advice: configAdvice.join(' ') || undefined,
			details: config,
		});
	}

	// 2. Loopback: the route tools try first.
	let loopbackOk = false;
	if (apiUrl !== url) {
		const target = `${apiUrl}/api/config`;
		const p = await probe(target, timeoutMs);
		const check = probeCheck('loopback', 'Loopback route (tools try this first)', target, p, 'loopback', relativePath);
		loopbackOk = check.status !== 'fail';
		checks.push(check);
	} else {
		checks.push({ id: 'loopback', title: 'Loopback route (tools try this first)', status: 'skip', summary: 'Not used with this configuration' });
	}

	// 3. DNS for the public name, as the forum host resolves it.
	let dnsOk = false;
	if (parsed) {
		const host = parsed.hostname.replace(/^\[|\]$/g, '');
		try {
			const addresses = await lookup(host, { all: true });
			dnsOk = addresses.length > 0;
			const list = addresses.map(a => a.address);
			const internal = list.every(a => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd)/.test(a));
			checks.push({
				id: 'dns',
				title: `DNS for ${host}`,
				status: 'ok',
				summary: `Resolves to ${list.join(', ')}${internal ? ' (internal)' : ' (public: the forum host must be able to route back to it)'}`,
				details: { host, addresses },
			});
		} catch (err) {
			const e = unwrap(err)!;
			checks.push({ id: 'dns', title: `DNS for ${host}`, status: 'fail', summary: `Does not resolve: ${e.code ?? e.message}`, advice: explain(e, 'public'), details: { host, error: e } });
		}
	}

	// 4. Public URL: the fallback, and what clients outside use.
	let publicOk = false;
	if (parsed) {
		const target = `${url}/api/config`;
		const p = dnsOk ? await probe(target, timeoutMs) : undefined;
		if (p) {
			const check = probeCheck('public', 'Public URL from the forum host (fallback route)', target, p, 'public', relativePath);
			publicOk = check.status !== 'fail';
			if (!publicOk && loopbackOk) {
				check.status = 'warn';
				check.advice = `${check.advice ?? ''} Tools do not need this route while loopback works, so this only matters if loopback breaks.`.trim();
			}
			checks.push(check);
		} else {
			checks.push({ id: 'public', title: 'Public URL from the forum host (fallback route)', status: 'skip', summary: 'Skipped: the name does not resolve' });
		}

		// 5. The MCP endpoint through the public URL: does the proxy pass it through to the plugin?
		if (publicOk) {
			const p = await probe(input.endpoint, timeoutMs, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
			});
			const details = { url: input.endpoint, status: p.status, ms: p.ms, headers: p.headers, error: p.error };
			if (p.status === 401 && p.headers?.['www-authenticate']?.toLowerCase().startsWith('bearer')) {
				checks.push({ id: 'endpoint', title: 'MCP endpoint through the public URL', status: 'ok', summary: 'Answers 401 with a Bearer challenge, as it should without a token', details });
			} else {
				checks.push({
					id: 'endpoint',
					title: 'MCP endpoint through the public URL',
					status: 'fail',
					summary: p.error ? `No response: ${p.error.code ?? p.error.name}` : `HTTP ${p.status} instead of a 401 Bearer challenge`,
					advice: 'The reverse proxy does not pass POST /api/mcp through to NodeBB unchanged (or strips WWW-Authenticate). MCP clients outside will fail to connect.',
					details,
				});
			}
		}
	}

	const route = loopbackOk ? 'loopback' : publicOk ? 'public' : 'none';
	const worst = checks.reduce<Status>((acc, c) => (c.status === 'fail' ? 'fail' : c.status === 'warn' && acc !== 'fail' ? 'warn' : acc), 'ok');
	const verdict: Status = route === 'none' ? 'fail' : worst;
	const headline = route === 'none'
		? 'Tools cannot reach the forum: neither the loopback address nor the public URL answers from inside the forum process. See the failed checks below.'
		: route === 'loopback'
			? `Tools reach the forum over loopback (${apiUrl}).${verdict === 'ok' ? ' Everything checks out.' : ' Some other checks need attention.'}`
			: `Loopback does not work, so tools fall back to the public URL (${url}). That works, but every tool call goes through the reverse proxy.`;

	return { at: new Date().toISOString(), verdict, headline, route, checks };
}
