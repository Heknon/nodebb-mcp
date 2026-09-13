# nodebb-mcp

An MCP server for NodeBB.

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
