# Elastic Agent Builder and Workflows

Two things live on the Elastic Cloud Serverless project besides the indices. Both are defined by files in this repo and applied by one script.

```sh
node scripts/elastic-setup.mjs            # create or update everything (safe to run twice)
node scripts/elastic-setup.mjs --check    # only report what exists
node scripts/elastic-setup.mjs --verify   # prove tools and workflow on throwaway indices, then clean up
node scripts/elastic-setup.mjs --verify --converse   # also ask a throwaway agent one question (uses the LLM)
```

The script reads `ELASTIC_URL` and `ELASTIC_API_KEY` through `src/env.mjs` (`ROLOE_ENV_FILE` or `.env`). Kibana's URL is the Elasticsearch URL with `.es.` replaced by `.kb.`; set `KIBANA_URL` to override. It prints one line per object with its id and HTTP status, and never prints the key or the hostname.

## The organizer's view (Agent Builder)

The organizer can ask how the conference is going. The agent answers from meeting metadata only and has no tool that can read what anyone shared.

Roloe's coordinator runs no model, and no model in the cloud ever reads what people share. This agent is the one place a hosted model (Elastic's, inside Agent Builder) touches Roloe data, and all it can reach is meeting metadata: counts, kinds, states and timings.

| Object | Id | File |
| --- | --- | --- |
| ES\|QL tool | `roloe.conference_pulse` | `elastic/agent-builder/tool.conference_pulse.json` |
| ES\|QL tool | `roloe.help_outcomes` | `elastic/agent-builder/tool.help_outcomes.json` |
| Agent | `roloe-organizer` ("Roloe organizer") | `elastic/agent-builder/agent.roloe-organizer.json` |

- Both tools query `roloe-meetings` only: one document per meeting, with kind, timings, finding counts and Try it state. No passages, names or content.
- `roloe.conference_pulse`: one row per hour with meetings, counts by kind, meetings with at least one finding, median seconds to findings, passing Try it count, and median seconds to help.
- `roloe.help_outcomes`: one row per Try it state with its share of meetings, how many were helped within the 120-second target, and the overall share within it.
- Each takes one optional integer parameter, `hours_back` (default 24). An ES|QL date parameter only accepts an ISO timestamp, not `now-24h`, so the window is given in hours and the model does not need to know the time.
- The agent's tool list is exactly those two tools, and `enable_elastic_capabilities` is `false`, which is the setting that keeps the built-in search and ES|QL tools out of the agent.

What the restriction does not cover: the project's Agent Builder MCP endpoint (`POST /api/agent_builder/mcp`) lists every tool on the project, including the built-in search and ES|QL tools, to any caller holding an API key with access. The organizer agent is restricted; the MCP endpoint is not scoped to that agent. Give an organizer the agent, not an API key.

### API shapes that worked (Kibana 9.7 Serverless)

| Action | Request |
| --- | --- |
| Create tool | `POST /api/agent_builder/tools` `{id, type: "esql", description, tags, configuration: {query, params: {name: {type, description, optional, defaultValue}}}}` |
| Update tool | `PUT /api/agent_builder/tools/{id}` with the same body minus `id` and `type` |
| Execute tool | `POST /api/agent_builder/tools/_execute` `{tool_id, tool_params}` |
| Create agent | `POST /api/agent_builder/agents` `{id, name, description, labels, configuration: {instructions, tools: [{tool_ids: [...]}], enable_elastic_capabilities}}` |
| Update agent | `PUT /api/agent_builder/agents/{id}` with the same body minus `id` |
| Ask agent | `POST /api/agent_builder/converse` `{agent_id, input}` |
| MCP | `POST /api/agent_builder/mcp` JSON-RPC, with `accept: application/json, text/event-stream` (without it: 406). Tool names swap dots for underscores. |

Headers: `authorization: ApiKey ...`, `content-type: application/json`, `kbn-xsrf: true`, `x-elastic-internal-origin: kibana`.

## Conference close (Workflow)

`elastic/workflows/roloe-conference-close.yaml`, id `roloe-conference-close`. When the conference day ends, shared copies are deleted.

- Triggers: daily at 02:00 UTC, and manual.
- Step `delete_shared_copies`: `_delete_by_query` on `roloe-passages` where `shared_at` is more than 12 hours old and `encounter_id` does not start with `card:`. A person's card is theirs and stays until they remove it.
- Step `mark_meetings_stopped`: `_update_by_query` on `roloe-meetings`, setting `stopped: true` where `started_at` is more than 12 hours old.
- A passage with no `shared_at` is never deleted by this workflow. Only copies written with `shared_at` are covered.
- The second step keys on the meeting's `started_at`, not on which copies the first step deleted, so a meeting can be marked stopped up to a run before its last copy is 12 hours old.
- This stack has no dedicated delete-by-query step type, so both steps use `elasticsearch.request`.

### API shapes that worked

| Action | Request |
| --- | --- |
| Schema | `GET /api/workflows/schema?loose=false` (JSON schema with every step and trigger type) |
| Create | `POST /api/workflows` `{workflows: [{yaml}]}`. `{yaml}` alone is rejected. The id is derived from the workflow's `name`. |
| Read | `GET /api/workflows/workflow/{id}` |
| Update | `PUT /api/workflows/workflow/{id}` `{yaml}` |
| Run | `POST /api/workflows/workflow/{id}/run` `{inputs: {}}` returns `{workflowExecutionId}` |
| Execution | `GET /api/workflows/executions/{executionId}` (`status`, `stepExecutions`) |
| Delete | `DELETE /api/workflows/workflow/{id}` |

## How it is verified

`--verify` never touches `roloe-meetings` or `roloe-passages`.

- Tools: creates `roloe-test-meetings-sample` with 8 sample meetings (7 inside 24 hours), creates copies of both tools pointed at it, executes them through the API and checks the numbers, then deletes the copies and the index.
- MCP: checks that `tools/list` includes the two real tools.
- Workflow: creates a copy of the workflow pointed at `roloe-test-wf-<timestamp>` holding four passages (an old card, an old shared copy, a recent shared copy, an old copy with no `shared_at`) and a meetings index with one old and one recent meeting. Runs the copy through the API and checks that only the old shared copy is gone and only the old meeting is stopped. Deletes the copy and both indices.

The real workflow has not been run by hand. It runs on its schedule.
