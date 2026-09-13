# Worked example — a non-trivial plugin, annotated

`nodebb-plugin-shotef` (<https://github.com/emotochat-droid/nodebb-shotef>) turns
NodeBB categories into a team-gated triage board with a rotating on-duty owner,
an audit trail, and cross-team hand-offs. It is the source this whole resource
set was distilled from: ~5,200 lines across server, client, and ACP, running on
NodeBB v4.x with Redis, with 18 `node:test` unit test files.

It is worth reading as a reference for how the pieces fit together at a size
where the naive single-file approach has already broken down.

## Module map

| File | Lines | Responsibility |
| --- | --- | --- |
| `library.js` | 76 | Wiring only: hooks → modules, route and socket registration |
| `lib/nbb.js` | 12 | The core-module loader |
| `lib/store.js` | 1014 | All persistence: keys, encode/decode, indexes, the state machine |
| `lib/controllers.js` | 574 | Page renders + JSON API handlers |
| `lib/sockets.js` | 439 | 21 socket methods, each authz-checking the caller |
| `lib/hooks.js` | 156 | The four `action:*` handlers |
| `lib/cron.js` | 139 | Scheduled jobs with pure, testable decision helpers |
| `lib/qanda.js` | 78 | Optional integration with another plugin |
| `lib/notify.js` | 71 | Best-effort notifications |
| `lib/realtime.js` | 32 | Room naming + broadcast |
| `public/js/client.js` | 2047 | The board UI |
| `public/js/admin.js` | 404 | The ACP editor |

The ratio is the lesson: `library.js` is 76 lines and `store.js` is 1,014.
Wiring stays thin; the domain lives in testable modules.

## What each surface is used for

**Page routes** — three client screens plus the ACP:

```js
routeHelpers.setupPageRoute(router, '/shotef', [middleware.ensureLoggedIn], controllers.renderBoard);
routeHelpers.setupPageRoute(router, '/shotef/audit', [middleware.ensureLoggedIn], controllers.renderAudit);
routeHelpers.setupPageRoute(router, '/shotef/shifts', [middleware.ensureLoggedIn], controllers.renderShifts);
routeHelpers.setupAdminPageRoute(router, '/admin/plugins/shotef', controllers.renderAdmin);
```

The board template is three lines — a mount point and a loading message. The
client fetches the real model from the API. The audit and shifts pages, which are
read-only tables, are rendered server-side in `.tpl` instead. Both choices are
right for their case.

**API routes** — data and CRUD, all scriptable with curl:

```js
router.get('/shotef/ping', (req, res) => res.json({ ok: 1, uid: req.uid }));
router.get('/shotef/board', wrap(controllers.apiBoard));
router.get('/shotef/public-status/:tid', wrap(controllers.apiPublicStatus));
router.get('/shotef/teams', wrap(controllers.apiGetTeams));
router.put('/shotef/teams/:teamId', wrap(controllers.apiSaveTeam));
router.delete('/shotef/teams/:teamId', wrap(controllers.apiDeleteTeam));
router.post('/shotef/teams/:teamId/backfill', wrap(controllers.apiBackfillTeam));
```

**Socket methods** — 21 of them, for the actions a user takes on a live board:
`transition`, `claim`, `unclaim`, `assign`, `take`, `takeOver`, `pass`,
`handover`, `setPriority`, `setTags`, `setDescription`, `setHelpWanted`,
`addNote`, `getNotes`, `getTicket`, `createTicket`, `reply`, `addReminder`,
`cancelReminder`, `markSolved`, `watch`.

The split is consistent: **sockets for actions on the open board** (they need to
broadcast a refresh to other viewers anyway), **API for data and configuration**
(so it can be scripted and tested with curl).

## The patterns worth copying

**One state machine, many callers.** `Store.transition()` does authorization, the
optimistic `expectedFrom` check, the field write, index maintenance, and the
audit append — in that order, in one place. Sockets, hooks, and cron all call it.
Nothing else writes status.

**Resolve behaviour from configuration, not hardcoded keys.** Teams can rename
their columns, so the reply-routing logic looks up columns by *role* rather than
by key:

```js
const answeredCol = (team.columns || []).find(c => c.publicStatus === 'answered');
const teamBallKey = team.reopensTo || 'waiting';
const hasTeamBall = !!Store.colByKey(team, teamBallKey);
```

A team that renamed "Waiting for Response" still routes, and a missing key
degrades instead of throwing.

**Two projections of one state.** Internally there are eight workflow columns;
externally the reporter sees four coarse stages (Received / In progress /
Awaiting your reply / Closed). The public projection is computed server-side, so
the team's internal workflow never leaks through the API.

**Every `action:*` handler is wrapped.** All four hook handlers have the same
shape: a `try` around the whole body, an early return on a missing payload, and
`winston.error` in the `catch`. A throw in an action hook helps nobody.

**Self-inflicted events are skipped.** The board's own "new task" button creates a
topic, which fires `action:topic.save`, which would enqueue it a second time. An
in-flight marker prevents it:

```js
if (Store.isCreateInFlight(topic.uid, topic.cid)) return;
```

**Optional integration degrades to nothing.** `lib/qanda.js` caches
`plugins.isActive('nodebb-plugin-question-and-answer')` once at init; every
helper returns a falsy default when inactive. Nothing in the rest of the plugin
branches on whether Q&A is installed.

**Broadcasts are pings, not diffs.** A mutation calls
`Realtime.emitTeam(teamId)`, every open board re-fetches its model. Simpler than
diffing, and always consistent.

## What the test suite covers

18 unit test files, none of which need NodeBB or Redis — they stub the `nodebb`
global and patch `Store.*`. They cover the board model projection, ball-in-court
routing, close reasons, contention between teams, ticket creation, cron
decisions, handover rules, notification targeting, the public status projection,
the Q&A gate, tags, title backfill, and text wrapping.

That's the payoff of the `nbb` indirection: essentially all of the domain logic
is reachable from a plain `node --test` run.

## Reading order

1. `plugin.json` — what's wired.
2. `library.js` — where each hook goes.
3. `lib/store.js` — the key schema at the top, then `transition()`.
4. `lib/hooks.js` — how forum events feed the board.
5. `tests/board-model.test.js` — the stub pattern in practice.

The repo also carries `DESIGN.md` (the full spec — data model, routing rules,
edge-case catalog) and a `.claude/skills/nodebb-plugin-dev/` skill, which is the
direct ancestor of these resources.
