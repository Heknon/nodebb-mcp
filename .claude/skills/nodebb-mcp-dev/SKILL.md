---
name: nodebb-mcp-dev
description: >-
  Building, extending, debugging, or testing nodebb-mcp (nodebb-plugin-mcp) — the
  NodeBB plugin that serves MCP from the forum itself (OAuth via the forum's own
  login, per-person API tokens), also runnable over stdio — which reads, answers
  from, posts to, and works triage tickets on a NodeBB forum — or
  any other client of NodeBB's HTTP APIs. Use when adding or changing a tool,
  touching capability probing (search / Q&A / Shotef), API-token identity
  (master tokens, _uid, tokens NodeBB silently downgrades to guest), the public
  write tools and NODEBB_ENABLE_WRITES, the Shotef ticket-working tools, the fake
  forum in tests/fake-forum.js, or the
  end-to-end suite against a real forum (e2e/forum.sh, e2e/seed.mjs,
  tests/e2e). Also for what NodeBB v4 really returns: raw titles, the Q&A
  duplicate answer, stale plugin fields, dbsearch duplicates, the Shotef board.
---

# Developing nodebb-mcp

An MCP server over a NodeBB forum: read tools (search, topics, posts,
listings), answer tools (`find_answers`, `investigate_issue`), triage tools
and ticket-working tools (Shotef), and opt-in public write tools. Two optional
plugins sharpen it —
`nodebb-plugin-question-and-answer` and Shotef — and full-text search needs a
search plugin (NodeBB v4 activates `nodebb-plugin-dbsearch` by default).
Everything degrades, and says so, when one is missing.

- `references/nodebb-api-reality.md` — what the forum **actually** returns, quirk
  by quirk, with the fix each needs. Read before touching `src/nodebb/` or
  `src/integrations/`.
- `references/e2e.md` — the real-forum suite: provisioning, seeding, identities,
  plugin toggling, writing a new e2e test, proving a test can fail.

## The one rule: the real forum wins

The first version of this server passed 67/67 tests against a hand-written fake
forum and then failed **13 of 22** e2e tests against a real NodeBB 4.16. The fake
encoded assumptions (escaped titles, a `topics[]` board, a token that 401s when
wrong); the real forum did none of those. So:

1. Every quirk the fake reproduces must have been **observed** on a real forum.
   When the e2e suite and the fake disagree, fix the fake.
2. New behaviour against a payload you have not seen: dump it from the live
   forum first (`curl` with a token — see `references/e2e.md`), then write code.
3. A test that passes on first run proves nothing until you have seen it fail —
   run the e2e suite against the old build (`E2E_SERVER=…`).

## Three test layers

| Layer | Command | Needs | Catches |
| --- | --- | --- | --- |
| Unit, fake forum over real HTTP | `npm test` | nothing | logic, formatting, degradation paths, write-tool contract |
| e2e, full stack | `npm run test:e2e` | seeded forum, plugins on | real payload shapes, identities, live hooks |
| e2e, core only | `npm run e2e` (toggles plugins) | seeded forum | real degradation, stale plugin state |

The plugin's OAuth is tested with the SDK's own OAuth client and a scripted
browser (`tests/oauth-harness.js`: forum login, Connect page) against the real
forum, and its store/provider in unit tests on an in-memory stand-in for
NodeBB's database (`tests/plugin-store.test.js`). A scripted browser is not a
browser: an earlier sign-in page passed every fetch-based test while real
Chromium could not finish it, and the ACP module looked fine until a browser
showed "define is not defined". `plugin-browser.e2e.test.js` runs headless
Chromium through the real login, Connect page and ACP; keep page changes covered
there.

`npm run e2e` does all of it: provision if needed → start → build → seed →
full-stack suites → plugins off → core suite → plugins back on (always, via a
trap). ~1 minute on a warm forum. e2e tests **skip** (not fail) when no seeded
forum is reachable, so `npm test` stays green anywhere.

## Adding or changing a tool — checklist

1. **Capability-aware.** Call `ctx.capabilities.get()` and branch on
   `isUsable(caps.x)`. A missing plugin is a normal state: return useful output
   plus a sentence saying what is missing, never an error.
2. **Pass `qna: isUsable(caps.qna)` to every reader** (`getTopic`, `listTopics`,
   `search`, `getPost`, `toTopicSummary`). It is a required parameter on purpose:
   Q&A's fields stay on topic hashes after the plugin is deactivated, and must
   not be trusted then.
3. **Never present an unconfirmed reply as accepted.** Label the basis
   (`describeBasis`): accepted / most-upvoted / first reply.
4. **Cite sources.** Every claim carries its URL (`client.link(...)`; posts as
   `/post/<pid>`, which NodeBB redirects to the right page).
5. **Errors → advice.** `toolError(action, err, advise?)` — pass
   `explainShotefError` for Shotef calls. Shotef errors arrive *translated*
   ("You are not a member of this team"), so match English text, not just keys.
6. **Read tools** get `annotations: { readOnlyHint: true, openWorldHint: true }`;
   the tools test asserts every default-advertised tool is read-only except the
   named set of Shotef ticket actions.
7. **Decide which side of the line a changing tool is on.**
   - Changes what the *public* sees (posts, replies, edits, votes, the accepted
     answer)? → `src/tools/write-tools.ts`, registered only with
     `NODEBB_ENABLE_WRITES`; start with `writeBlocker(caps)`.
   - Changes the *team's* Shotef state (notes, status, owner, priority, pass)?
     → `src/tools/triage-actions.ts`, always registered; start with
     `triageBlocker(caps)` (needs Shotef + a verified identity — Shotef itself
     authorizes membership). These go through Shotef's HTTP routes
     (`applyTicketAction`), never sockets — sockets can't take API tokens.
   Either way a guest or silently-downgraded token is refused *before* anything
   is sent, and the tool re-reads state afterwards and shows it.
8. **One action per tool.** Annotations (`readOnlyHint`, `destructiveHint`,
   `idempotentHint`) must hold for *every* input — a bundled tool can't be
   honest (a note is not idempotent; a status move is), clients approve per
   tool, and models find `add_ticket_note` by name, not inside another tool's
   parameters. Group only fields of the same kind of change
   (`set_ticket_priority` = priority + help-wanted). Never keep an overlapping
   bundled tool alongside the scoped ones.
9. **Names, not just ids.** An input naming a team, category or person takes
   the name too: `categoryInput` + `withCategories(ctx, 'read' | 'write', …)` for
   categories, `findTeam` / `getBoard` for teams, the board's `members` for
   people, all through `resolveName` (`src/resolve.ts`). Reads act on a unique
   near miss and report it; writes act only on an exact match and answer
   anything else with `nameProblem` ("did you mean …?"). Never pick between
   ambiguous matches.
10. Add the fake-forum behaviour the tool needs (observed first), a unit test, and
   an e2e assertion. Then `npm run check && npm run e2e`.

## Identity: verify, never assume

Three modes (`client.authMode`): a username/password session (`src/session.ts`
— the transparent default for users), an API token, or none. A token wins if
both are set. In password mode the client signs in lazily (once, shared),
renews a lost session and retries once, never retries a refused sign-in, and
caches the session in a 0600 file so restarts don't count against NodeBB's
login rate limits. See the reference for the observed login behaviour.

**The NodeBB plugin** (`src/plugin/`, `library.cjs`, `plugin.json`, `templates/`,
`public/`): the forum serves MCP at `/api/mcp` (inside NodeBB's API namespace) and is its own OAuth 2.1
authorization server. Consent is a forum page (`/mcp/connect`) behind the
forum's own login (so SSO and 2FA just work); allowing mints a NodeBB API token
for the person, and their tools run the shared code over the forum's own HTTP
API (loopback) with that token — every call checked by NodeBB as theirs.
OAuth state (clients, pending consents, codes, grants, hashed tokens) is in the
forum's database (`src/plugin/store.ts`); the MCP endpoint is stateless (a server
per request), so multi-process forums need nothing extra. A grant ends when the
person disconnects it (`/mcp/connections`), an admin revokes it (ACP) or deletes
its API token, or the client revokes its refresh token. Things that bit:
- The SDK's `mcpAuthRouter` mounts `/register` at the origin root — NodeBB's
  sign-up page. Mount the SDK's individual handlers under `/api/mcp/oauth/` instead.
- Discovery (`/.well-known/oauth-*<forum path>/api/mcp`) is at the origin root:
  mount it on `params.app` in `static:app.load` (ahead of NodeBB's router, which
  sits under the forum's subpath), the rest on `params.router`.
- NodeBB sets `trust proxy` in `listen()`, *after* `static:app.load`: read it on
  first request, not at load.
- Make the NodeBB API token when the code is **redeemed**, not on Allow, or every
  abandoned Allow leaves a live full-account token behind.
- NodeBB's own body parser has read the body before plugin routes run (its size
  limit applies; a 413 is NodeBB's HTML page).
- NodeBB is Express 4, the SDK Express 5: only the plugin's own paths are handed
  to an Express 5 sub-app, and request/response prototypes are restored on the
  way out. Copy NodeBB's `trust proxy` into it, or rate limits see the proxy.
- OAuth error text ends up in `WWW-Authenticate`: ASCII only.
- `meta.settings` saves are published to every process (`action:settings.set.<hash>`
  over pubsub): subscribe and drop your settings cache, don't poll.

The **stdio** entry (`src/index.ts`) remains for running it on one machine as
one account (token or password).

Two rules that came out of the e2e runs:
- A sign-in failure is error kind `sign-in`, never `auth` — several readers
  treat `auth` as "not permitted" and would turn it into a polite note.
- `capabilities.get()` **throws** a sign-in failure (tools then fail with the
  reason); `capabilities.report()` never throws (`forum_capabilities`). Otherwise
  a dead session probes as "plugin unknown" and tools degrade as if Shotef were
  missing.

NodeBB **does not reject an unknown bearer token** — it serves the request as a
guest. `hasToken` means nothing; `caps.forum.authenticated` (from `/api/config`
→ `uid`) is the truth. A **master token** needs `_uid` on every call
(`NODEBB_UID`); without it the Read API answers a bare HTTP 500 while the Write
API (`/api/v3/ping`) explains — `CapabilityRegistry.explainAuthFailure` asks it.
`forum_capabilities` prints "Acting as: <user> (uid N) — verified by the forum".

## Layout

```
src/index.ts            stdio entry; logs to stderr only (stdout is the protocol)
src/server.ts           McpServer + instructions
src/config.ts           env → Config for stdio (the plugin builds its Config from NodeBB's nconf + ACP settings)
src/client.ts           fetch wrapper: Read API, v3 envelope unwrap, write(), _uid, session retry
src/session.ts          password sign-in: cookie jar, CSRF, renewal, refusal memory, session file
src/plugin/             the NodeBB plugin: index (routes, pages, ACP, stateless /api/mcp),
                        provider (OAuthServerProvider: consent → NodeBB API token), store (db-backed)
library.cjs, plugin.json, templates/, public/   what NodeBB loads (CommonJS bridge, hooks, pages, ACP JS)
src/capabilities.ts     probes + verified identity + writes/triage capabilities, TTL-cached
src/nodebb/forum.ts     topics/posts/search/listings/core writes, normalized
src/integrations/       qna.ts (answers, unsolved), shotef.ts (status, board, tickets, actions)
src/research.ts         candidate gathering (search or scan), answer resolution, investigation
src/tools/              forum-, answer-, triage- (reads), triage-actions (Shotef workflow),
                        write-tools (public, flag-gated) + format.ts
tests/fake-forum.js     NodeBB v4.16 model over real HTTP (stateful writes)
tests/e2e/              harness + read / write / core / plugin / plugin-browser suites against a real forum
e2e/                    forum.sh, seed.mjs, mint-tokens.cjs, run.sh
resources/              NodeBB plugin-authoring corpus served as nodebb://plugin-dev/*
```

Keep `CLAUDE.md` for this container's paths and credentials; keep this skill for
what transfers to any NodeBB forum.
