# nodebb-mcp

An MCP server for **investigating issues, finding answers, and working support
tickets on a NodeBB forum**.

Point it at a forum and it searches the forum's own history, extracts the answers
that already exist, and says what is still open — so a question gets answered from
what the community already worked out rather than from guesswork. On a forum
with the Shotef triage plugin it also works tickets — internal notes, status,
ownership, priority — as a team member; with public writes enabled it can post,
reply, vote and accept answers too.

It integrates with two optional NodeBB plugins for sharper results, and **works
without either of them**.

## Install

```bash
npm install && npm run build
```

## Configure

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `NODEBB_URL` | yes | — | Forum root, e.g. `https://forum.example.com` (a subdirectory mount is fine) |
| `NODEBB_API_TOKEN` | no | — | Bearer token from ACP → Settings → API Access. Without it the server is a guest: public content only, and no search (guests lack `search:content` by default) |
| `NODEBB_UID` | no | — | Acting uid. Required when the token is a **master** token; ignored for user tokens |
| `NODEBB_ENABLE_WRITES` | no | off | `1`/`true` registers the **public** write tools (post, reply, edit, vote, accept an answer). Off, nothing can change what the forum's readers see. Shotef's team-workflow actions don't need it |
| `NODEBB_TIMEOUT_MS` | no | `15000` | Per-request timeout |
| `NODEBB_MAX_POSTS_PER_TOPIC` | no | `50` | Cap on posts pulled per topic |
| `NODEBB_CAPABILITY_TTL_MS` | no | `300000` | How long plugin detection is cached |
| `NODEBB_SHOTEF_NAMESPACE` | no | `shotef` | Plugin id namespace under `/api/v3/plugins/<id>` |

Add it to an MCP client:

```json
{
  "mcpServers": {
    "nodebb": {
      "command": "node",
      "args": ["/path/to/nodebb-mcp/dist/index.js"],
      "env": {
        "NODEBB_URL": "https://forum.example.com",
        "NODEBB_API_TOKEN": "your-token"
      }
    }
  }
}
```

## Tools

**Answering**

| Tool | Does |
| --- | --- |
| `find_answers` | Find topics that already answer a question and extract the answer from each |
| `investigate_issue` | Full sweep on a problem report: existing answers, still-open reports, triage state, next steps |
| `get_topic_answer` | The answer to one topic — accepted if Q&A is installed, best reply otherwise |
| `list_unanswered_questions` | The queue of questions nobody has answered |

**Reading**

| Tool | Does |
| --- | --- |
| `search_forum` | Full-text search with snippets |
| `get_topic` | A thread in full, accepted answer and triage status marked |
| `get_post` | One post with its topic |
| `list_categories` | Category tree with ids |
| `list_recent_topics` | recent / popular / top / unread listings |

**Triage** (Shotef)

| Tool | Does |
| --- | --- |
| `get_triage_status` | Is anyone working on this topic, and was it resolved |
| `get_triage_board` | The team's board: active columns, parked backlog, intake; the status keys `set_ticket_status` takes |
| `get_ticket` | A ticket in full for team members: status, owner, audit timeline, internal notes |

**Working tickets** (Shotef) — the team's own workflow, so **no writes flag needed**: a team
member's token and Shotef's own authorization are enough. One action per tool.

| Tool | Does |
| --- | --- |
| `add_ticket_note` | Internal note, visible to the handling team only |
| `set_ticket_status` | Move to a column; close as resolved or no-response (an unsolved question can't close as resolved); optional reason on the timeline |
| `assign_ticket` | Claim (`me`), release (`nobody`), or assign a teammate (managers) |
| `set_ticket_priority` | Priority and/or the help-wanted flag |
| `pass_ticket` | Hand a ticket to another team |

**Public writes** — only with `NODEBB_ENABLE_WRITES=1`, as the token's user

| Tool | Does |
| --- | --- |
| `create_topic` | New topic, optionally as a Q&A question; lands on the owning team's board |
| `reply_to_topic` | Public reply; reports the ticket move it caused (Shotef's ball-in-court routing) |
| `edit_post` | Replace a post's body (and a first post's title) |
| `vote_post` | Up / down / withdraw |
| `mark_solved` | Accept a reply as a question's answer — shown on the public thread (Q&A + Shotef) |

**Diagnostics**

| Tool | Does |
| --- | --- |
| `forum_capabilities` | Which features are live, who the forum says we are, and what is missing |

Prompts encode the usual tool order for each workflow: `answer_forum_question`,
`investigate_report`, and `work_ticket` (research, answer, accept, close — with
public writes off, it drafts the reply into an internal note for a person to post).

## Optional integrations, and life without them

Everything is probed against the live forum at startup and re-probed on a TTL.
Nothing here is required; a missing plugin is a normal state that every tool
degrades around and **states in its own output**, so a thin answer is never
mistaken for a confident one.

| Integration | Probe | With it | Without it |
| --- | --- | --- | --- |
| **Search plugin** (`nodebb-plugin-dbsearch`, a NodeBB v4 default) | `/api/config` → `searchEnabled`, then `GET /api/search` for the privilege | Real relevance ranking over titles and post bodies | Falls back to scanning recent-topic listings and ranking titles by term overlap; says it can only see recent activity |
| **`nodebb-plugin-question-and-answer`** | `/api/config` → `question-and-answer` key (else `GET /api/unsolved`) | Author-**accepted** answers; a real unsolved queue; solved markers; `mark_solved` | Uses the most-upvoted reply, explicitly labelled *not marked accepted*; approximates the queue with reply-less topics; ignores Q&A fields left behind on topics |
| **Shotef triage** | `GET /api/v3/plugins/shotef/ping` | Workflow stage, team, board, tickets, and the ticket-working tools | Reports triage as unknowable here and points you at the thread itself |

NodeBB core ships **no search of its own** — its search controller 404s unless a
plugin listens on `filter:search.query` — which is why search is treated as
optional. Guests are refused search by default, so an anonymous server scans.

**Identity is verified, not assumed.** NodeBB serves an invalid or revoked token
as a *guest* rather than rejecting it, so `forum_capabilities` reports who the
forum actually resolved (`/api/config` → `uid`) and flags a token that was not
honoured, or a master token missing `NODEBB_UID`.

**Shotef needs the HTTP ticket routes** (`/api/v3/plugins/shotef/tickets/…`,
added alongside a fix that makes its routes honour API tokens at all). Older
Shotef releases treat every token as a guest; `forum_capabilities` warns when it
detects one.

**Where the line is.** `NODEBB_ENABLE_WRITES` guards what the public sees: posts,
replies, edits, votes, and the accepted answer on a thread. Working a ticket
(notes, status, ownership, priority, passing) is the team's own state, so it is
available whenever Shotef is live and the token belongs to a team member. The
reporter sees only the coarse stage ("in progress", "closed"), and Shotef notifies
them when it changes. A deployment that must not touch the board at all should
use a token outside the triage teams.

Everything follows the forum's permissions, not the server's: posting needs the
user's NodeBB privileges, and every ticket action is checked by Shotef (team
membership; a manager to assign someone else; an unsolved question cannot be
closed as resolved until an answer is accepted). A refusal comes back with the
forum's reason and what to do about it.

The rule the tools follow: an unconfirmed reply is never presented as an accepted
answer. `find_answers` always labels its basis (`accepted answer`,
`most-upvoted reply (not marked accepted)`, `first reply`), and
`get_topic_answer` on an open question reports it as genuinely unanswered instead
of guessing.

## Development

```bash
npm run build      # compile to dist/
npm test           # unit tests against a fake forum — no NodeBB needed
npm run e2e        # end-to-end against a real NodeBB (provisions one if missing)
npm run check      # build (tests import dist/) + unit tests
```

**Unit tests** (`tests/*.test.js`) run a fake NodeBB over real HTTP
(`tests/fake-forum.js`) that models v4.16 with dbsearch, Q&A and Shotef —
including the quirks that bite: tokens NodeBB silently downgrades to guest, guests
refused search, Q&A's duplicated accepted answer and its stale fields, dbsearch's
duplicate hits, the Shotef board shape, stateful core and ticket writes. Plugins
switch per test, so every degradation path runs; tool tests drive a real MCP
client over an in-memory transport.

**End-to-end tests** (`tests/e2e/`) launch the built server as separate stdio
processes — one per forum identity — against a real NodeBB seeded through its
own Write API (`e2e/seed.mjs`), so plugin hooks fire for real. The full-stack
suites cover every read tool as admin, team member, outsider, guest, a bogus
token and a master token, and walk one ticket through its life (created → claimed
→ answered → refused while unsolved → solved → closed → found by `find_answers`).
The core suite deactivates all three plugins on the same forum and checks the
degradation. The fake forum is kept faithful to what the e2e suite observes;
when they disagree, the real forum wins.

`e2e/forum.sh` manages the forum (`provision`, `up`, `restart`, `status`,
`plugins on|off`). See `CLAUDE.md` and `.claude/skills/nodebb-mcp-dev/` for the
details.

## `resources/` — NodeBB plugin-authoring knowledge base

Ten markdown documents covering how to build a NodeBB plugin (v3/v4), plus
`resources/index.json`, a manifest mapping each document to an MCP resource URI
so the server can serve them verbatim.

| URI | File | Covers |
| --- | --- | --- |
| `nodebb://plugin-dev/overview` | `00-overview.md` | Mental model, plugin anatomy, the five rules, triage |
| `nodebb://plugin-dev/architecture` | `10-architecture.md` | `nbb` loader, layout, lifecycle, cluster, notifications |
| `nodebb://plugin-dev/hooks` | `20-hooks-reference.md` | `static:`/`filter:`/`action:` families and semantics |
| `nodebb://plugin-dev/endpoints` | `30-endpoints.md` | Page routes, `/api/v3/plugins`, socket.io, realtime |
| `nodebb://plugin-dev/data-layer` | `40-data-layer.md` | The `db` abstraction, key design, encoding, caching |
| `nodebb://plugin-dev/client-acp-templates` | `50-client-acp-templates.md` | Client scripts, ACP modules, `.tpl`, languages, CSS |
| `nodebb://plugin-dev/gotchas` | `60-gotchas.md` | 17 traps as symptom → cause → fix |
| `nodebb://plugin-dev/testing` | `70-testing.md` | `node:test` units, seeding, HTTP, Playwright |
| `nodebb://plugin-dev/recipes` | `80-recipes.md` | Scaffolding, dev environment, reusable snippets |
| `nodebb://plugin-dev/worked-example` | `90-worked-example.md` | Annotated tour of a real ~5,200-line plugin |

### Manifest shape

```json
{
  "uri": "nodebb://plugin-dev/gotchas",
  "name": "nodebb-plugin-gotchas",
  "title": "Gotchas — the hours-eaters",
  "description": "…",
  "mimeType": "text/markdown",
  "path": "60-gotchas.md",
  "keywords": ["gotchas", "debugging", "…"]
}
```

`uri`, `name`, `title`, `description`, and `mimeType` are the fields an MCP
`resources/list` response needs. `path` is relative to `resources/index.json` and
tells the server what to read for `resources/read`. `keywords` is extra, for
search or tool-side filtering.

Reading the manifest is a few lines in any language, for example:

```js
const manifest = require('./resources/index.json');

const listResources = () => manifest.resources.map(
  ({ uri, name, title, description, mimeType }) => ({ uri, name, title, description, mimeType })
);

const readResource = (uri) => {
  const entry = manifest.resources.find(r => r.uri === uri);
  if (!entry) throw new Error(`unknown resource: ${uri}`);
  return {
    contents: [{
      uri,
      mimeType: entry.mimeType,
      text: fs.readFileSync(path.join(__dirname, 'resources', entry.path), 'utf8'),
    }],
  };
};
```

### Provenance

Distilled from [`nodebb-plugin-shotef`](https://github.com/emotochat-droid/nodebb-shotef)
— its `.claude/skills/nodebb-plugin-dev/` skill, its `CLAUDE.md`, its `dev/`
tooling, and its plugin source (~5,200 lines across `library.js`, `lib/`,
`public/js/`, `templates/`, and 18 `node:test` files).

Everything here was verified against **NodeBB v4.x on Node 22** with Redis; most
of it applies to v3 as well.

### Maintaining

The documents are plain markdown with no build step. To add one: write the file
in `resources/`, then add an entry to `resources/index.json`. Keep the numeric
filename prefixes — they give the corpus a reading order.
