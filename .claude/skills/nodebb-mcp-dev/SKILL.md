---
name: nodebb-mcp-dev
description: >-
  Building, extending, debugging, or testing nodebb-mcp — the MCP server that
  reads, answers from, posts to, and works triage tickets on a NodeBB forum — or
  any other client of NodeBB's HTTP APIs. Use when adding or changing a tool,
  touching capability probing (search / Q&A / Shotef), API-token identity
  (master tokens, _uid, tokens NodeBB silently downgrades to guest), the write
  tools and NODEBB_ENABLE_WRITES, the fake forum in tests/fake-forum.js, or the
  end-to-end suite against a real forum (e2e/forum.sh, e2e/seed.mjs,
  tests/e2e). Also for what NodeBB v4 really returns: raw titles, the Q&A
  duplicate answer, stale plugin fields, dbsearch duplicates, the Shotef board.
---

# Developing nodebb-mcp

An MCP server over a NodeBB forum: read tools (search, topics, posts,
listings), answer tools (`find_answers`, `investigate_issue`), triage tools
(Shotef), and opt-in write tools. Two optional plugins sharpen it —
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
   the tools test asserts every default-advertised tool is read-only.
7. **Write tools** go in `src/tools/write-tools.ts`, which is registered only
   when `NODEBB_ENABLE_WRITES` is on. Start with `writeBlocker(caps)` (or
   `triageBlocker`) so a guest or a silently-downgraded token is refused
   *before* anything is sent. Report each sub-step; re-read state after a write
   and show it. Triage actions go through Shotef's HTTP routes
   (`applyTicketAction`), never sockets — sockets can't take API tokens.
8. Add the fake-forum behaviour the tool needs (observed first), a unit test, and
   an e2e assertion. Then `npm run check && npm run e2e`.

## Identity: verify, never assume

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
src/config.ts           env → Config (NODEBB_URL required; NODEBB_ENABLE_WRITES opt-in)
src/client.ts           fetch wrapper: Read API, v3 envelope unwrap, write(), _uid
src/capabilities.ts     probes + verified identity + writes capability, TTL-cached
src/nodebb/forum.ts     topics/posts/search/listings/core writes, normalized
src/integrations/       qna.ts (answers, unsolved), shotef.ts (status, board, tickets, actions)
src/research.ts         candidate gathering (search or scan), answer resolution, investigation
src/tools/              forum-, answer-, triage-, write-tools + format.ts
tests/fake-forum.js     NodeBB v4.16 model over real HTTP (stateful writes)
tests/e2e/              harness + read / write / core suites against a real forum
e2e/                    forum.sh, seed.mjs, mint-tokens.cjs, run.sh
resources/              NodeBB plugin-authoring corpus served as nodebb://plugin-dev/*
```

Keep `CLAUDE.md` for this container's paths and credentials; keep this skill for
what transfers to any NodeBB forum.
