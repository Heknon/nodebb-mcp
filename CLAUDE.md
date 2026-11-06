# CLAUDE.md — working on nodebb-mcp in a cloud agent container

The transferable knowledge (what NodeBB really returns, how the e2e suite works,
the tool checklist) is in the skill: `.claude/skills/nodebb-mcp-dev/`. This file
is the container-specific part: paths, credentials, and the operational traps.

If a path below doesn't exist, discover it rather than assume
(`ls /home/user`, `find / -maxdepth 4 -name nodebb-plugin-shotef -type l 2>/dev/null`).

---

## 1. Where everything lives

| Thing | Path / value |
| --- | --- |
| This repo | `/home/user/nodebb-mcp` |
| Shotef plugin (sibling checkout) | `/home/user/nodebb-shotef` — its own `CLAUDE.md` covers plugin work |
| NodeBB (v4.x) | `/home/user/NodeBB` |
| Plugin symlinks NodeBB loads | `node_modules/nodebb-plugin-shotef` → `/home/user/nodebb-shotef`; `node_modules/nodebb-plugin-mcp` → **this repo** (it is a NodeBB plugin) |
| Redis data | `/home/user/NodeBB/redis/dump.rdb` (RDB) |
| NodeBB log (forum.sh) | `/tmp/nodebb-e2e.log` |
| Forum | <http://127.0.0.1:4567>, admin `admin` / `Test1234!`. Its configured `url` is `http://localhost:4567`: OAuth issuer, resource and links use that host |
| MCP endpoint (this plugin) | <http://localhost:4567/mcp>; ACP → Plugins → MCP; people's page `/mcp/connections` |
| e2e fixture (ids + API tokens) | `e2e/.fixture.json` (gitignored; written by `e2e/seed.mjs`) |
| Chromium (if ever needed) | `/opt/pw-browsers/chromium` |

Active plugins for the full stack: `nodebb-plugin-dbsearch` (a NodeBB v4
default), `nodebb-plugin-question-and-answer`, `nodebb-plugin-shotef`.

## 2. Fresh container? One command

```bash
cd /home/user/nodebb-mcp && npm ci && npm run e2e
```

`npm run e2e` provisions NodeBB if `/home/user/NodeBB` is missing (clone v4.x,
Shotef's `dev/setup.sh`, Q&A, build — several minutes), starts Redis and NodeBB,
builds, seeds, and runs every suite. `git clone` of GitHub works here even though
HTTPS fetches to github.com are blocked by the proxy; npm registry is open.

## 3. Day-to-day loop

```bash
npm run build && npm test            # unit: fake forum, no NodeBB needed (~2s)
npm run test:e2e                     # e2e against the running forum as-is
npm run e2e -- --full-only           # build + seed + full-stack e2e, no plugin restarts
npm run e2e                          # everything, incl. the plugins-off pass (~1 min)
e2e/forum.sh status                  # Redis / forum / symlink / plugin state
```

The MCP server is a separate process per e2e identity; it reads `dist/`, so
**rebuild before e2e** (`npm run e2e` does).

Probe the live forum directly before trusting a payload shape:

```bash
TOKEN=$(node -p "require('./e2e/.fixture.json').tokens.admin")
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4567/api/config | python3 -m json.tool
```

Tokens in the fixture: `master` (uid 0 — needs `_uid`), `admin`, `maintainer`
(team member, not manager), `outsider` (no team). Mint more with
`NODEBB_DIR=/home/user/NodeBB node e2e/mint-tokens.cjs <uid…>`.

Passwords: every `e2e_*` user's is `fixture.password`; `admin` is `Test1234!`.
`e2e_wrongpass` exists only to fail sign-ins against. The seed raises
`ipLoginAttempts` on this test forum (NodeBB locks an IP after 20 sign-ins an
hour, and e2e runs sign in repeatedly from 127.0.0.1).

The forum serves this repo as `nodebb-plugin-mcp`. After changing it:

| Changed | Then |
| --- | --- |
| `src/**` (server code) | `npm run build && e2e/forum.sh restart` (`npm run e2e` does both) |
| `templates/`, `public/admin.js`, `plugin.json` | `npm run build && e2e/forum.sh build` (rebuilds NodeBB's assets, restarts) |

Connect a real client to it (sign in with any `e2e_*` user and `fixture.password`):

```bash
claude mcp add --transport http forum http://localhost:4567/mcp   # in a throwaway HOME
```

## 4. Traps (each one cost time here)

- **Redis is not a service.** It may be down at session start. Never start it
  bare — `e2e/forum.sh up` starts it on the right data dir and refuses an empty
  DB. If `redis-cli dbsize` is ~0, you started it on the wrong dir:
  `redis-cli shutdown nosave` (don't overwrite the dump), then `e2e/forum.sh up`.
- **Never pipe `./nodebb start`.** It daemonizes but keeps stdout open, so
  `./nodebb start | tail` hangs the shell forever. `forum.sh` redirects to a file.
- **Plugin toggles need a restart**, not a rebuild (`forum.sh plugins on|off`
  restarts). If a core-only run was interrupted, the full-stack suites will all
  *skip* with "live: none" — run `e2e/forum.sh plugins on`.
- **Shotef server edits** (in `/home/user/nodebb-shotef/lib`) need
  `e2e/forum.sh restart`; its unit tests are `cd ../nodebb-shotef && npm test`.
- **`npm install` inside `/home/user/NodeBB` prunes the Shotef symlink** →
  Shotef routes 404. `e2e/forum.sh up` re-links; then restart.
- **This repo is ESM (`"type": "module"`), NodeBB is CommonJS.** NodeBB
  `require()`s `library.cjs`, which `import()`s `dist/plugin/index.js`; and
  `public/package.json` scopes `public/` back to CommonJS — without it NodeBB's
  webpack drops the ACP module's `define()` ("define is not defined") and the
  ACP page silently does nothing.
- **Nothing that can reach a header may be non-ASCII.** The SDK copies an OAuth
  error's message into `WWW-Authenticate`; an em dash there made Node refuse to
  send the 401 at all, and NodeBB answered with an HTML error page.
- **Out-of-process DB writes are invisible** to the running forum (caches).
  The seed avoids this by writing through the live Write API; if you do write
  Redis directly, restart.
- **A bad token doesn't fail** — NodeBB serves it as a guest. If results look
  thin, check `forum_capabilities` → "Acting as".
- **Locked out while probing logins?** NodeBB locks an account after 5 failed
  sign-ins (60 min) and an IP after too many sign-ins. On this dev forum only:
  `redis-cli del lockout:<uid> loginAttempts:<uid> loginAttempts:ip:127.0.0.1`.
  Probe with passwords of 6+ characters — shorter ones are rejected uncounted.

## 5. Git

- `main` is what ships. Work lands on the designated working branch and reaches
  `main` only when the user asks for the merge. (GitHub's default branch may
  still be `claude/nodebb-mcp-plugin-resources-k8brz2`, the history `main`
  started from.) Don't push elsewhere without being asked; don't open PRs
  unless asked.
- `main` needs a Shotef build with its HTTP API (`/api/v3/plugins/shotef/tickets/…`)
  for the ticket tools; until that is on Shotef's `main` too, a forum running
  Shotef `main` gets them reported as unavailable (see README → Plugins).
- Commit author must be `noreply@anthropic.com`; no model ids in commits or PRs.
- Cross-repo changes (e.g. a Shotef route this server needs) go to Shotef's own
  working branch, committed and pushed there, and are verified by this repo's
  e2e suite against the symlinked checkout.
