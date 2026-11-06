/**
 * The pages a person sees while connecting an MCP client: sign in to the
 * forum, or a short message. Self-contained HTML (no external assets — the
 * server may run air-gapped), light and dark aware, every value escaped.
 */

const escape = (value: string) => value
	.replace(/&/g, '&amp;')
	.replace(/</g, '&lt;')
	.replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;')
	.replace(/'/g, '&#39;');

const STYLE = `
:root { --bg:#f6f7f9; --card:#fff; --text:#1d2330; --muted:#5b6475; --line:#d9dde5; --accent:#2f6fde; --on-accent:#fff; --danger:#b42318; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#14171c; --card:#1d2128; --text:#e7eaf0; --muted:#9aa3b2; --line:#323844; --accent:#6d9cff; --on-accent:#0b1426; --danger:#ff8a80; }
}
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px;
  background:var(--bg); color:var(--text); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width:100%; max-width:380px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; }
h1 { font-size:20px; margin:0 0 6px; }
p { margin:0 0 16px; color:var(--muted); }
strong { color:var(--text); }
label { display:block; font-weight:600; margin:14px 0 6px; }
input { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font:inherit; }
input:focus { outline:2px solid var(--accent); outline-offset:1px; }
.error { color:var(--danger); background:color-mix(in srgb, var(--danger) 10%, transparent); border-radius:8px; padding:10px 12px; margin:0 0 8px; }
.actions { display:flex; gap:10px; margin-top:20px; }
button { flex:1; padding:10px 12px; border-radius:8px; font:inherit; font-weight:600; cursor:pointer; border:1px solid var(--line); background:transparent; color:var(--text); }
button.primary { background:var(--accent); border-color:var(--accent); color:var(--on-accent); }
.fine { font-size:13px; margin:16px 0 0; }
`;

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export interface SignInPage {
	forumName: string;
	clientName: string;
	/** Where the person will be sent back to, so they can tell what they are approving. */
	redirectHost: string;
	requestId: string;
	username?: string;
	error?: string;
}

export function signInPage(view: SignInPage): string {
	return page(`Sign in to ${view.forumName}`, `
<h1>Sign in to ${escape(view.forumName)}</h1>
<p><strong>${escape(view.clientName)}</strong> wants to use the forum as you: read what you can read,
and act where your account may act. You will be sent back to <strong>${escape(view.redirectHost)}</strong>.</p>
${view.error ? `<p class="error" role="alert">${escape(view.error)}</p>` : ''}
<form method="post" action="/oauth/sign-in" autocomplete="on">
  <input type="hidden" name="request" value="${escape(view.requestId)}">
  <label for="username">Forum username</label>
  <input id="username" name="username" autocomplete="username" required value="${escape(view.username ?? '')}" ${view.username ? '' : 'autofocus'}>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required ${view.username ? 'autofocus' : ''}>
  <div class="actions">
    <button type="submit" name="action" value="deny" formnovalidate>Cancel</button>
    <button type="submit" name="action" value="allow" class="primary">Sign in</button>
  </div>
</form>
<p class="fine">Your password goes to the forum to sign you in and is not stored. To end this access later,
sign the session out from your forum account's sessions page.</p>`);
}

export function messagePage(title: string, message: string): string {
	return page(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`);
}
