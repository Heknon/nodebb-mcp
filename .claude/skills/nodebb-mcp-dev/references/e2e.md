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
| `e2e/seed.mjs` | The fixture, through the live Write API as each user (master token + `_uid`), so plugin hooks fire. Writes `e2e/.fixture.json` (gitignored): ids, uids, cids, tokens. Reuses an intact fixture; `--fresh` purges categories + team and rebuilds. |
| `tests/e2e/harness.js` | `e2e({ needs })` → `{ fixture, opts }` (skip reason when the forum is absent or in the wrong plugin state, asked of the forum itself); `spawnMcp(fixture, { as, env })`; `eventually()`; `grabId()`. |
| `tests/e2e/read.e2e.test.js` | Read tools as admin / team member / outsider / guest / bogus token / master ± `NODEBB_UID`. |
| `tests/e2e/write.e2e.test.js` | One ticket's whole life: the reporter, the team member *without* the writes flag (all ticket work), and the same member *with* it (public reply, accepting the answer), as separate processes. Per-run marker in titles so reruns never collide. |
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
- A new topic/state you need belongs in `seed.mjs`; bump nothing — the fixture is
  rebuilt with `--fresh`.

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
