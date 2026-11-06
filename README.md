# nodebb-mcp

An MCP server for a NodeBB forum: search it, pull answers out of existing
threads, investigate problem reports, and work support tickets on a
[Shotef](https://github.com/emotochat-droid/nodebb-shotef) triage board.

Works on a plain NodeBB forum; the search, Q&A and Shotef plugins each unlock
more (see [Plugins](#plugins)).

## Quick start

```bash
npm install && npm run build
```

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

Then call `forum_capabilities` to check who the forum says you are and which
plugins are live.

## Tools

What a tool may change decides when it is available:

| Changes | Available | Who may use it |
| --- | --- | --- |
| nothing | always | anyone the forum lets read the content |
| **ticket** — Shotef team state | always, when Shotef is installed | members of the team handling the ticket, and administrators (Shotef checks) |
| **public** — what forum readers see | only with `NODEBB_ENABLE_WRITES=1` | the token's user, within their NodeBB privileges |

| Tool | Does | Changes | Needs |
| --- | --- | --- | --- |
| `forum_capabilities` | Who you are on the forum, which plugins are live, what is missing | nothing | — |
| `find_answers` | Topics that already answer a question, with the answer from each, labelled accepted or merely upvoted | nothing | — |
| `investigate_issue` | Existing answers, still-open reports, triage state, and next steps for a problem report | nothing | — |
| `search_forum` | Full-text search with snippets | nothing | a search plugin and a token (otherwise a recent-titles scan) |
| `get_topic` | A thread in full, accepted answer and triage stage marked | nothing | — |
| `get_topic_answer` | The answer to one topic | nothing | Q&A for an accepted answer (otherwise the top reply, labelled) |
| `get_post` | One post with its topic | nothing | — |
| `list_categories` | Category tree with ids | nothing | — |
| `list_recent_topics` | Recent, popular, top or unread topics | nothing | a token for `unread` |
| `list_unanswered_questions` | Questions nobody has answered | nothing | Q&A (otherwise topics with no replies) |
| `get_triage_status` | A topic's stage: received, in progress, answered, closed | nothing | Shotef |
| `get_triage_board` | A team's board by column, plus the status keys `set_ticket_status` takes | nothing | Shotef, team member |
| `get_ticket` | A ticket with its history and internal notes | nothing | Shotef, team member |
| `add_ticket_note` | Leave an internal note only the team sees | ticket | Shotef, team member |
| `set_ticket_status` | Move a ticket, or close it as resolved or no-response | ticket | Shotef, team member |
| `assign_ticket` | Claim, release, or assign a ticket | ticket | Shotef, team member (manager to assign someone else) |
| `set_ticket_priority` | Set priority and the help-wanted flag | ticket | Shotef, team member |
| `pass_ticket` | Hand a ticket to another team | ticket | Shotef, team member |
| `create_topic` | Start a topic, optionally as a Q&A question | public | `NODEBB_ENABLE_WRITES` |
| `reply_to_topic` | Post a reply | public | `NODEBB_ENABLE_WRITES` |
| `edit_post` | Replace a post's text | public | `NODEBB_ENABLE_WRITES` |
| `vote_post` | Upvote, downvote, or withdraw a vote | public | `NODEBB_ENABLE_WRITES` |
| `mark_solved` | Accept a reply as a question's answer | public | `NODEBB_ENABLE_WRITES`, Q&A, Shotef, team member |

Ticket changes are not entirely invisible: the reporter sees the coarse stage
("in progress", "closed") and Shotef notifies them when it changes. Notes and
the ticket history stay with the team. To keep a server off the board entirely,
give it a token for a user who is on no triage team and is not an administrator
(Shotef treats administrators as members of every team).

**Prompts:** `answer_forum_question` and `investigate_report` chain the read tools;
`work_ticket` takes a ticket from report to closed (with public writes off, it
drafts the reply into a note for a person to post).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODEBB_URL` | required | Forum root, e.g. `https://forum.example.com` (a subpath is fine) |
| `NODEBB_API_TOKEN` | — | API token (ACP → Settings → API Access). Without one the server is a guest: public content only, and no search |
| `NODEBB_UID` | — | User to act as. Required with a master token; ignored with a user token |
| `NODEBB_ENABLE_WRITES` | off | `1` / `true` enables the public tools |
| `NODEBB_TIMEOUT_MS` | `15000` | Per-request timeout |
| `NODEBB_MAX_POSTS_PER_TOPIC` | `50` | Posts read per topic |
| `NODEBB_CAPABILITY_TTL_MS` | `300000` | How long plugin detection is cached |
| `NODEBB_SHOTEF_NAMESPACE` | `shotef` | Shotef's route prefix under `/api/v3/plugins/` |

**Check your token.** NodeBB does not reject an invalid or revoked token; it
quietly treats the caller as a guest. `forum_capabilities` shows the user the
forum actually resolved and flags a token it ignored, or a master token without
`NODEBB_UID`.

## Plugins

None are required. When one is missing, the tools still answer and say in their
output what they could not see.

| Plugin | With it | Without it |
| --- | --- | --- |
| Search: `nodebb-plugin-dbsearch` (on by default in NodeBB v4) | Ranked search over titles and post bodies, for a token's user (guests lack the search privilege by default) | A scan of recent topic titles, flagged as such |
| `nodebb-plugin-question-and-answer` | Accepted answers, the unsolved queue, `mark_solved` | The most-upvoted reply, labelled *not marked accepted*; the queue becomes topics without replies |
| [Shotef](https://github.com/emotochat-droid/nodebb-shotef) | Triage stage, board, tickets, and the ticket tools | Triage is reported as unknown |

Shotef needs its HTTP API (`/api/v3/plugins/shotef/tickets/…`). Earlier releases
ignore API tokens, so the board looks empty; `forum_capabilities` warns when it
sees one.

An unconfirmed reply is never presented as an accepted answer, and every refusal
from the forum comes back with its reason and what to do about it.

## Development

```bash
npm run check      # build + unit tests (fake forum, no NodeBB needed)
npm run e2e        # build, seed and test against a real NodeBB; provisions one if missing
```

- **Unit tests** (`tests/*.test.js`) run against `tests/fake-forum.js`, an HTTP
  model of NodeBB 4.16 with the three plugins.
- **End-to-end tests** (`tests/e2e/`) start the built server once per forum
  identity against a real forum seeded by `e2e/seed.mjs`. They run once with all
  plugins on and once with them off. `e2e/forum.sh` starts, stops and inspects
  that forum.

When the two disagree, the real forum wins and the fake is fixed. `CLAUDE.md`
covers this container; `.claude/skills/nodebb-mcp-dev/` covers NodeBB's API
quirks and how to add a tool.

## Plugin-authoring docs

The server also serves a guide to writing NodeBB plugins (v3/v4) as MCP
resources, distilled from the Shotef plugin:

| URI | Covers |
| --- | --- |
| `nodebb://plugin-dev/overview` | Mental model, plugin anatomy, the five rules |
| `nodebb://plugin-dev/architecture` | The `nbb` loader, layout, lifecycle, clustering, notifications |
| `nodebb://plugin-dev/hooks` | `static:` / `filter:` / `action:` hooks and how they fire |
| `nodebb://plugin-dev/endpoints` | Page routes, `/api/v3/plugins` routes, socket.io |
| `nodebb://plugin-dev/data-layer` | The `db` abstraction, key design, caching |
| `nodebb://plugin-dev/client-acp-templates` | Client scripts, ACP modules, templates, languages, CSS |
| `nodebb://plugin-dev/gotchas` | 17 traps as symptom → cause → fix |
| `nodebb://plugin-dev/testing` | `node:test` units, seeding, HTTP and browser checks |
| `nodebb://plugin-dev/recipes` | Scaffolding, dev environment, snippets |
| `nodebb://plugin-dev/worked-example` | An annotated tour of a real plugin |

They live in `resources/` as plain markdown. To add one, write the file and add
an entry to `resources/index.json`.
