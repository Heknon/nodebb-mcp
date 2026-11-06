# What NodeBB actually returns

Observed on NodeBB **v4.16.7** with `nodebb-plugin-dbsearch` 7.0.7,
`nodebb-plugin-question-and-answer` 2.0.5 and Shotef 0.2.x, by the e2e suite.
Each entry: what you'd assume → what really happens → what the code does.
`tests/fake-forum.js` reproduces every one; keep the two in step.

## Identity and auth

**Bad token = guest, not 401.** `middleware/user.js` → `authenticate()`: if
passport finds no user for the bearer token it simply `return true`s, and the
request proceeds as uid 0. A typo'd or revoked token produces *thinner results*,
not an error. → `/api/config` returns `uid` and `loggedIn`; the capability probe
records `forum.authenticated = uid > 0` and an `authProblem` when a token is set
but uid is 0.

**Master token without `_uid`.** Read API (`/api/config`, `/api/topic/…`): HTTP
**500**, no useful body. Write API: **400** `"A master token was received without
a corresponding \`_uid\` in the request body"`. → on a failed config probe with a
token, ask `/api/v3/ping` for the explanation. `_uid` may ride on the query
string for every verb (we always send it there).

**Guest writes** fail CSRF before any route runs: plain-text `403 Forbidden`, not
JSON. Bearer-authenticated requests are exempt from CSRF.

**Creating tokens** over HTTP (`POST /api/v3/admin/tokens`) requires an
interactive password re-auth. Tokens are plain db records with no in-process
cache, so a NodeBB-context script can mint them behind a running forum
(`api.utils.tokens.generate({ uid, description })`, uid 0 = master) — see
`e2e/mint-tokens.cjs`.

**`/api/v3/users/:uid`** → `{ uid, username, … }`; used to name the acting user.

## Password sign-in (cookie sessions)

What `src/session.ts` is built on — all observed with curl on the live forum:

- **Handshake.** An anonymous `GET /api/config` sets `express.sid` and returns
  `csrf_token`. `POST /api/v3/utilities/login {username, password, remember:'on'}`
  needs that cookie **and** `x-csrf-token`, else a plain-text `403 Forbidden`.
  Success → 200 with the user object and a **new** `express.sid` (the session is
  regenerated); the CSRF token stays the same. `remember: 'on'` makes the session
  last `loginDays` (14).
- **Writes** on a cookie session need `x-csrf-token`; without it → plain-text
  `403 Forbidden`. GETs don't.
- **Refusals** are `text/html` 403 bodies holding a raw key:
  `[[error:invalid-login-credentials]]` (unknown users get the same — no
  enumeration), `[[error:account-locked]]`, `[[error:ip-locked]]`.
- **Rate limits** (`src/user/auth.js`): more than `loginAttempts` (5) failures in
  an hour lock the account for `lockoutDuration` (60 min) — after that even the
  right password is refused. Every attempt, successful or not, also counts
  toward `ipLoginAttempts` (20) per IP per hour. A password **shorter than 6** is
  rejected before anything is counted — a probe with "nope" proves nothing.
- **Expiry is silent.** A revoked or expired session is served as a guest; no
  error. Read API page payloads carry `loggedIn`/`loggedInUser` (and a fresh
  `Set-Cookie`), so they reveal it. Write API GETs (Shotef's board, `/posts/:pid/…`)
  carry **no signal at all** — not even a cookie — and quietly return guest data
  (`{ noTeam: true }`). Writes fail CSRF; some routes 401. Hence: renew on
  `loggedIn: false` / 401 / CSRF-403, and re-confirm a session older than
  `NODEBB_SESSION_CHECK_MS` before a Write API read.
- **Revoking** a session (tests): `GET /api/user/<slug>/sessions` lists them,
  `DELETE /api/v3/users/:uid/sessions/:uuid` revokes (self or admin).
- A bearer-token request also creates a server session (`finishLogin`), so a
  user's session list includes token traffic.

## Config (`/api/config`)

- **No `version` field** — NodeBB v4 never exposes it there. Don't print one.
- `uid`, `loggedIn` — the acting identity.
- `searchEnabled` — `true` iff some plugin listens on `filter:search.query`.
  `false` answers "no search plugin" without calling `/api/search`.
- `question-and-answer: {…}` — present only while Q&A is active
  (its `filter:config.get`). A free, privilege-free Q&A probe.

## Search (`GET /api/search?term=…&searchOnly=1`)

- **Guests are refused: 401** "A valid login session was not found". The
  `search:content` global privilege is not granted to guests by default. →
  capability `forbidden`, reason names the privilege; tools fall back to a scan.
- With **no search plugin**, the controller calls `next()` → 404 (JSON
  `{status:{code:'not-found'}}` under `/api`).
- **dbsearch returns the same post twice** when it matches title and body;
  `matchCount` counts the duplicates. → dedupe by pid, adjust the count.
- Hits are post summaries: **no `index`**. → link `/post/<pid>`.
- Q&A's `filter:post.getPostSummaryByPids` sets `topic.isQuestion` and
  `topic.isSolved` on **every** hit as `parseInt(field)` — so a non-question is
  `null` (JSON of `NaN`). → only a hit with truthy `isQuestion` is solved or
  unsolved.
- Array params go as `categories[]=3&categories[]=4` (`hasTags[]` likewise).

## Titles and text

- **v4 returns titles raw from every API surface** — topic, v3 topic, listings,
  category pages, search: `Tips for writing "good" bug reports <with examples>`
  comes back exactly so. The famous "titles are HTML-escaped" applies to
  *server-side* `topics.getTopicsFields`/`getTopicData` (plugin code), and to
  older forums. → `decodeTitle` decodes once; harmless on raw text, correct on
  escaped. (`escapeTitles: true` in the fake covers the older behaviour.)
- Category `description` is raw; `descriptionParsed` is rendered HTML.
- Post `content` from `/api/topic/:tid` and `/summary` is **rendered HTML**;
  `/api/v3/posts/:pid` is the **raw markdown**. → `htmlToText` keeps code fences,
  lists, quotes and link targets.
- Tags arrive as `[{ value, valueEncoded, class }]`.

## Topics and posts

- `/api/topic/:tid` carries every topic-hash field, so plugin state rides along:
  Q&A's `isQuestion`/`isSolved`/`solvedPid` as **strings** ("1").
- **The Q&A duplicate.** When the accepted answer is not the first reply, Q&A's
  `filter:topic.getPosts` *inserts a copy* of it right after the opening post,
  flagged `allowDupe`/`navigatorIgnore`, and sets `isAnswer` on both copies. A
  naive reader shows the answer twice, out of order. → `dedupePosts`: keep each
  pid once (originals before copies), sort by `index`.
- **Stale plugin state.** Deactivate or uninstall Q&A and its fields stay on the
  hashes, still served. Trusting them resurrects an "accepted answer" nobody can
  see or change. → every reader takes a required `qna: boolean` and ignores Q&A
  fields unless the capability is live.
- `/api/v3/posts/:pid` has **no `user` object** (author shows as "uid 4") and no
  index. → `/api/v3/posts/:pid/summary` has `user`, `topic` (Q&A-decorated),
  `category`, rendered `content`. Mark accepted via the topic's `solvedPid`.
- Write shapes: `POST /api/v3/topics` → the topic (`tid`, `mainPid`, `slug`, …);
  `POST /api/v3/topics/:tid` → the post (`pid`, `tid`, `index`);
  `PUT /api/v3/posts/:pid` → the post at top level; votes → `{}` (re-read the
  post for the score). Voting on your own post → 400 "You cannot vote on your own
  post". `DELETE /api/v3/topics/:tid` purges.
- Q&A marks a question at creation if the body merely **has** an `isQuestion`
  key (`hasOwnProperty`) — don't send `isQuestion: 0` meaning "no".
- Q&A's "accept this answer" is **socket.io only** (`plugins.QandA.markPostAsAnswer`).
  Over HTTP it is reachable only through Shotef's `PUT /tickets/:tid/solved`.

## Shotef (`/api/v3/plugins/shotef/…`)

- **≤ 0.2.0 ignored API tokens**: routes were bare `router.get`, which skips
  `authenticateRequest`. `/ping` → `{ ok: 1, uid: 0 }` even for an admin token.
  → the probe compares ping's uid with the verified uid and warns.
- **Administrators count as members and managers of every team**
  (`Store.isMember`/`isManager` fall back to `isAdministrator`), so an admin
  token can work any ticket and sees every board. A server that must stay off
  the board needs a non-admin user on no team.
- **Board**: `{ teams, me, team: { id, name }, columns: [{ key, label, class,
  publicStatus, count, cards: [...] }], backlog: [...same, parked lanes],
  intake: [...cards], shotef: { username } | null, isManager, … }`. A viewer on no
  team: **200** `{ noTeam: true, teams: [] }` (not 403). Closed tickets sit in the
  `terminal` column of `columns`.
- Card: `tid, title, slug, status, priority, claimedBy: { username } | null,
  helpWanted, isQuestion?, isSolved?, openDays, idleDays, noReplyDays?, ghost?,
  handledByName?, closeReason`.
- `public-status/:tid`: `{ tracked, status: received|in_progress|answered|closed,
  label, closeReason, teamName, parked, holdReason (members only), isMember }`.
  Its `label` is **reporter-facing** ("Awaiting your reply") — render your own.
- `tickets/:tid`: `timeline[]` entries have `actor` as a **username string**
  ("system" for automatic moves) and `toUsername` for claim/assign; `notes[]`
  are `{ body, ts, author }`, empty for non-members.
- Errors come back **translated** over HTTP, with real statuses (401/403/404/409/
  400/501). Unknown status key → 400 "Unknown status"; closing an unsolved
  question → 409 "Mark this question as solved before closing it"
  (`closeReason: "no_response"` skips that gate).
- Live hooks you can rely on: a new topic in a team-owned category is tracked as
  `todo`; a team member's reply on an active ticket → `responded` (public
  `answered`); the reporter's reply → `waiting`; a reply on a closed ticket
  reopens it.

## Operations that look like bugs

- Plugin (de)activation needs a **restart** (not a rebuild, for the API surface).
  Shotef caches "is Q&A active" at init.
- `./nodebb start` keeps the caller's stdout open: `./nodebb start | tail` hangs
  forever. Redirect to a file.
- `npm install` inside NodeBB prunes symlinked plugins (`bun add` did not, here).
