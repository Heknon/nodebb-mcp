# The end-to-end suite

Real MCP server processes (`node dist/index.js`) over real stdio, against a real
NodeBB forum with real plugins, seeded through the forum's own Write API.
Nothing is stubbed: Shotef's hooks route replies, Q&A's gate refuses to close an
unsolved question, dbsearch indexes new posts live.

## Running

```bash
npm run e2e                  # provision if needed, start, build, seed, all suites (~1 min warm)
npm run e2e -- --full-only   # skip the plugins-off pass (no restarts)
npm run e2e -- --fresh       # purge and rebuild the fixture first
npm run test:e2e             # just the tests, against whatever state the forum is in
```

Env: `NODEBB_DIR` (default `/home/user/NodeBB`), `NODEBB_URL`
(`http://127.0.0.1:4567`), `SHOTEF_DIR` (`../nodebb-shotef`), `E2E_FIXTURE`,
`E2E_SERVER` (another build to test, e.g. an older `dist/index.js`).

`e2e/forum.sh` manages the forum: `provision | up | down | restart | status |
plugins on|off`. `provision` clones NodeBB v4.x and runs Shotef's own
`dev/setup.sh` (deps, persisted Redis, setup, link, build), then adds Q&A.

## Pieces

| File | Role |
| --- | --- |
| `e2e/mint-tokens.cjs` | NodeBB-context script: idempotent API tokens (`uid 0` = master). HTTP token creation needs a password re-auth; tokens have no cache, so this is safe behind a live forum. |
| `e2e/seed.mjs` | The fixture, through the live Write API as each user (master token + `_uid`), so plugin hooks fire. Writes `e2e/.fixture.json` (gitignored): ids, uids, cids, tokens. Reuses an intact fixture (re-applying the fixture tickets' triage state, so a hand-made change never leaks into the next run); `--fresh` purges categories + team and rebuilds. |
| `tests/e2e/harness.js` | `e2e({ needs })` → `{ fixture, opts }` (skip reason when the forum is absent or in the wrong plugin state, asked of the forum itself); `spawnMcp(fixture, { as, env })`; `eventually()`; `grabId()`. |
| `tests/e2e/read.e2e.test.js` | Read tools as admin / team member / outsider / guest / bogus token / master ± `NODEBB_UID`. |
| `tests/e2e/write.e2e.test.js` | One ticket's whole life: the reporter, the team member *without* the writes flag (all ticket work), and the same member *with* it (public reply, accepting the answer), as separate processes. Per-run marker in titles so reruns never collide. |
| `tests/e2e/session.e2e.test.js` | Password sign-in on the real forum: identity, cookie + CSRF writes (Shotef and core), session reuse across processes, renewal after a real revocation, a wrong password tried once. |
| `tests/e2e/oauth.e2e.test.js` | The shared HTTP server, spawned as `node dist/index.js` with `NODEBB_MCP_HTTP_PORT`: discovery, two real people signing in (SDK OAuth client + scripted browser), isolation, a wrong password on the page, a session signed out on the forum ending only that person's access (and listed as `nodebb-mcp` there), `/revoke` logging NodeBB out, the state file holding no password or usable token. |
| `tests/e2e/oauth-browser.e2e.test.js` | The sign-in page in headless Chromium (Playwright): a wrong password, then the right one, the redirect back to the client, and the client connecting. Catches what only a browser enforces (CSP, form-action resolution). Skips without Playwright. |
| `tests/e2e/core.e2e.test.js` | Same forum, plugins deactivated: degradation and stale Q&A state. |

## The fixture

Users `e2e_reporter`, `e2e_helper`, `e2e_maintainer`, `e2e_outsider` (password in
the fixture file). Categories **E2E Support & Help** (owned by team
`e2e-support` "Support & Ops": admin, helper, maintainer; admin manages),
**E2E General Discussion**, **E2E Staff Only** (read privileges rescinded from
every default group). Topics — each chosen to trip one quirk:

| Key | What it exercises |
| --- | --- |
| `redis` | solved question, accepted answer **not** the first reply (Q&A duplicate), code fences, `&` in title, body-only search word `ECONNREFUSED`, closed/resolved ticket |
| `symlink` | open question, no replies; assigned, high priority, in work |
| `images` | open question with an upvoted reply (must not become "the answer"); parked as Blocked |
| `digest` | plain discussion with an upvoted reply (most-upvoted fallback); Responded; dbsearch duplicate hit |
| `welcome` | untracked topic in an unowned category |
| `quoting` | `"`, `<`, `>` in a title |
| `staff` | private-category leak check |

## Writing a new e2e test

```js
import { e2e, spawnMcp } from './harness.js';
const { fixture: fx, opts } = await e2e({ needs: 'full' });   // or 'core'

test('…', opts, async () => {
  // Ticket actions need only a team member; add env: { NODEBB_ENABLE_WRITES: '1' } for public writes.
  const mcp = await spawnMcp(fx, { as: 'maintainer' });
  try {
    const { text, isError } = await mcp.call('get_ticket', { tid: fx.topics.symlink.tid });
    assert.match(text, /…/);
  } finally { await mcp.close(); }
});
```

- Assert on **ids from the fixture**, never on hard-coded numbers.
- Assert inclusion, not exact sets: write tests add topics on every run.
- Search indexing and caches are asynchronous — wrap such reads in `eventually()`.
- e2e **files run in parallel**. Never let two suites sign in as a user whose
  sessions one of them revokes (the session suite owns `e2e_maintainer`'s
  sessions; the OAuth suite uses `e2e_helper` / `e2e_reporter`).
- Repeated runs hit NodeBB's daily limits (votes, logins). The seed's
  `ensureBaseline()` raises them on the test forum; add new ones there.
- A new topic/state you need belongs in `seed.mjs`; bump nothing — the fixture is
  rebuilt with `--fresh`.

### Identities

`spawnMcp(fx, { as })`: `'admin' | 'maintainer' | 'outsider' | 'master' | 'anon'`
or a literal token; `{ username, password }` signs in with a password
(`fx.password` is every `e2e_*` user's). Give password servers their own
`NODEBB_SESSION_FILE` in a temp dir.

**Trap: the harness sets `NODEBB_CAPABILITY_TTL_MS=0`**, so every tool call
re-probes `/api/config` — which itself notices a dead password session and
renews it. A session-expiry test that keeps that default passes for the wrong
reason; set the TTL high (as in production) to test the mechanism you mean.

## Looking at raw payloads first

```bash
TOKEN=$(node -p "require('./e2e/.fixture.json').tokens.admin")
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4567/api/topic/<tid> | python3 -m json.tool
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:4567/api/v3/plugins/shotef/board?team=e2e-support"
```

## Proving a test can fail

```bash
git worktree add /tmp/old <old-commit> && (cd /tmp/old && cp -r "$OLDPWD/node_modules" . && npx tsc)
E2E_SERVER=/tmp/old/dist/index.js node --test tests/e2e/read.e2e.test.js
git worktree remove --force /tmp/old
```

The pre-e2e build fails 13/22 read tests; that is the suite's baseline value.

## When it goes wrong

1. Forum up? `e2e/forum.sh status`. Redis `dbsize` near 0 = started on the wrong
   dir: `redis-cli shutdown nosave`, then `e2e/forum.sh up`.
2. Full-stack tests all **skipped** with "live: none"? A core run was interrupted
   before its trap ran: `e2e/forum.sh plugins on`.
3. Seed fails on posting → post queue / rate limits: the seed sets `postQueue`,
   `postDelay`, `initialPostDelay`, `newbiePostDelay` to 0 via
   `PUT /api/v3/admin/settings/:key`; check they took.
4. Shotef routes 404 → plugin symlink gone (`npm install` in NodeBB):
   `e2e/forum.sh up` re-links it; then restart.
5. Changed Shotef server code? `e2e/forum.sh restart`. Client assets don't
   matter to the API.
