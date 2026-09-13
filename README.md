# nodebb-mcp

An MCP server for **investigating issues and finding answers on a NodeBB forum**.

Point it at a forum and it searches the forum's own history, extracts the answers
that already exist, and says what is still open — so a question gets answered from
what the community already worked out rather than from guesswork.

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
| `NODEBB_API_TOKEN` | no | — | Bearer token from ACP → Settings → API Access. Without it the server sees only publicly readable content |
| `NODEBB_UID` | no | — | Acting uid. Required when the token is a **master** token; ignored for user tokens |
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

**Triage**

| Tool | Does |
| --- | --- |
| `get_triage_status` | Is anyone working on this topic, and was it resolved |
| `get_triage_board` | The team's board by workflow column |

**Diagnostics**

| Tool | Does |
| --- | --- |
| `forum_capabilities` | Which features are live on this forum, and what is missing |

Two prompts, `answer_forum_question` and `investigate_report`, encode the usual
tool order for each workflow.

## Optional integrations, and life without them

Everything is probed against the live forum at startup and re-probed on a TTL.
Nothing here is required; a missing plugin is a normal state that every tool
degrades around and **states in its own output**, so a thin answer is never
mistaken for a confident one.

| Integration | Probe | With it | Without it |
| --- | --- | --- | --- |
| **Search plugin** (e.g. `nodebb-plugin-dbsearch`) | `GET /api/search` | Real relevance ranking over titles and post bodies | Falls back to scanning recent-topic listings and ranking titles by term overlap; says it can only see recent activity |
| **`nodebb-plugin-question-and-answer`** | `GET /api/unsolved` | Author-**accepted** answers; a real unsolved queue; solved markers on results | Uses the most-upvoted reply, explicitly labelled *not marked accepted*; approximates the queue with reply-less topics |
| **Shotef triage** | `GET /api/v3/plugins/shotef/ping` | Workflow stage, handling team, parked/closed reasons | Reports triage as unknowable here and points you at the thread itself |

NodeBB core ships **no search of its own** — its search controller 404s unless a
plugin listens on `filter:search.query` — which is why search is treated as
optional rather than assumed.

The rule the tools follow: an unconfirmed reply is never presented as an accepted
answer. `find_answers` always labels its basis (`accepted answer`,
`most-upvoted reply (not marked accepted)`, `first reply`), and
`get_topic_answer` on an open question reports it as genuinely unanswered instead
of guessing.

## Development

```bash
npm run build     # compile to dist/
npm test          # 67 tests, no forum required
npm run check     # typecheck + tests
```

Tests run against a fake NodeBB over real HTTP (`tests/fake-forum.js`) that
reproduces the shapes that actually bite — HTML-escaped titles, rendered-HTML post
bodies, the `{ status, response }` envelope, and a 404 on `/api/search` when no
search plugin is installed. Plugins are switchable per test, so the degradation
paths are exercised directly: `tests/degradation.test.js` runs the whole tool
surface against a forum with none of them. `tests/tools.test.js` drives a real MCP
client against a real server over an in-memory transport.

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
| `nodebb://plugin-dev/gotchas` | `60-gotchas.md` | 16 traps as symptom → cause → fix |
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
