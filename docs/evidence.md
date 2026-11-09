# Evidence

What each sponsor tool does in Roloe, with links and numbers. Only what has actually happened is listed; what's still open is marked open.

## Gitar: every change reviewed

- PRs [#1](https://github.com/WestonBDev/roloe/pull/1)–[#12](https://github.com/WestonBDev/roloe/pull/12) were reviewed by Gitar against `.gitar/review/roloe-invariants.md` and merged in order after approval and green CI.
- Gitar's findings were fixed as red-then-green test commits, each named "(Gitar)" in `git log`. Examples:
  - **Security:** a private key pasted across a chunk boundary could leak its second half (scrub now runs before chunking) ([#2](https://github.com/WestonBDev/roloe/pull/2)).
  - **Security:** Try it could write through a symlink into the real project; containers ran as root and outlived their timeout ([#7](https://github.com/WestonBDev/roloe/pull/7)).
  - **Bug:** two posts from one side at once bypassed the three-findings limit ([#5](https://github.com/WestonBDev/roloe/pull/5)).
  - **Security:** guest taps weren't rate-limited, and a forged `X-Forwarded-For` could dodge the limit ([#8](https://github.com/WestonBDev/roloe/pull/8)).
  - **Deploy:** Argo CD self-heal would revert a manual ConfigMap edit; `/data` was ephemeral; the init container ran an unpinned branch ([#9](https://github.com/WestonBDev/roloe/pull/9)).
- Repository rules: `.gitar/rules/` holds one rule per privacy invariant ([#19](https://github.com/WestonBDev/roloe/pull/19)). Custom rules are a Gitar Pro feature, so on our tier they may show as not evaluated.
- **A real CI failure, diagnosed and fixed by Gitar** ([#19](https://github.com/WestonBDev/roloe/pull/19)): a new CI step scans every tracked file for secret-shaped strings with Roloe's own scrubber patterns. It went red on four real literals in test fixtures (a JWT and private-key armour). Asked with `Gitar fix CI`, Gitar diagnosed it (change-related, high confidence) and pushed the fix itself: commit `6ec29ef` "test: assemble secret fixtures at runtime", authored by Gitar. Its review of that PR then caught that the scan missed env-style `KEY=value` secrets; that rule was added test-first.

## Elasticsearch: the data layer and the privacy boundary

- Elastic Cloud Serverless 9.7 project. The RRF retriever (BM25 + `semantic_text` on `.elser-2-elastic`) runs overlap retrieval at every meeting.
- Scoped keys: Serverless refuses to derive a key with privileges from an API key. Its own words: *"creating derived api keys requires an explicit role descriptor that is empty (has no privileges)"*. So scope is the coordinator's `encounter_id` filter on every read, and the coordinator says so from startup. On a licensed cluster with user credentials, each meeting gets a document-level-security key (`scripts/elastic-check.mjs` prints the live mode and a raw no-filter proof).
- Stop sends the old key back to Elasticsearch and records its answer (0 documents).
- **Any language.** ELSER is English-only. A second `semantic_text` field on `.jina-embeddings-v5-text-small` (Elastic Inference Service) was added to the live index with one `PUT _mapping`, no reindex, and overlap retrieval now fuses three rankings with RRF. Measured on the production project, one English passage among 150 real ones, asked for in another language: with keywords + ELSER the passage was missed in Spanish, Japanese, Hindi and Portuguese; with Jina added it came back at rank 2 to 6 of 150 (rank 1 on the Jina ranking alone). `node scripts/elastic-check.mjs` reruns a small version of this. Indexing 150 passages with both fields took 2.1–3.5 s, against 2.8 s with ELSER alone.
- **Meeting records.** `roloe-meetings` holds one metadata record per meeting (id, kind, times, counts, outcomes; `dynamic: strict`, so nothing else can be written). It is the first meeting state to live in Elasticsearch rather than on the pod's volume.
- **Agent Builder, custom tools.** Two ES|QL tools over `roloe-meetings` only (`roloe.conference_pulse`, `roloe.help_outcomes`) and an agent, `roloe-organizer`, restricted to exactly those two with Elastic's built-in tools switched off. Verified through the API on sample data (7 meetings: 5 with findings, 3 passing Try it; 2 of 3 within the 120 s target), and asked once to look up what people shared: it called only its pulse tool and answered that the organizer view cannot see content. Honest limit: the restriction is the agent's; the project's Agent Builder MCP endpoint lists every tool to any API-key holder, so Roloe does not hand that endpoint to anyone.
- **Workflow.** `roloe-conference-close` (daily 02:00 UTC, or by hand) deletes meeting copies whose `shared_at` is more than 12 hours old and never touches a person's own card. Verified on a throwaway index: of an old card copy, an old meeting copy and a new meeting copy, only the old meeting copy was deleted. It has not been run on the live index today, and copies made before `shared_at` existed never match.
- Details, payload shapes and what is not verified: [elastic-agent-builder-and-workflows.md](elastic-agent-builder-and-workflows.md).
- Open: the rest of meeting state in Elastic (needed for a second replica); reusing stored embeddings when a card is copied into a meeting (the largest cost Dash0's Agent0 named).

## Dash0: traces and metrics from the first route

- Every request is a span; every meeting is one trace (`roloe.tap`, `roloe.overlap`, `roloe.guest_read`, `roloe.pull`, `roloe.findings`, `roloe.finding.check`, `roloe.try`, `roloe.probe`, `roloe.stop`). Attributes are IDs, counts and per-meeting HMACs, never text.
- Metrics: `roloe.meetings`, `roloe.findings`, `roloe.help`, `roloe.time_to_help` (seconds; 120 s bucket for the SLO), `roloe.time_to_findings`. `scripts/otlp-check.mjs`: Dash0 accepted both a trace and a metric batch.
- Found with traces: the guest page's "Opening…" took 3–14 s; the `roloe.tap` span showed copying 305 passages (with ELSER inference) took 3.2–4.4 s. Fix: the guest page now answers at once and the meeting is prepared behind it (2–16 ms).
- Logs: meeting events (`meeting.started`, `meeting.instant_shown`, `meeting.findings_posted`, `meeting.nothing_strong`, `meeting.stopped`, `meeting.failed`, `guest.input_read`/`guest.input_failed`, `guest_try.state`, `http.server_error`) are OpenTelemetry log records carrying the trace and span they happened in, so a Dash0 log line opens its meeting's trace. Bodies come from that fixed list only; a test runs a real guest meeting and checks its logs share one trace and hold none of the guest's words. `scripts/otlp-check.mjs`: Dash0 accepted a log record with its trace ID on 9 November.
- Open: the SLO and dashboard set up in Dash0, an Agent0 diagnosis.

## Radar / Argo CD

- Manifests ready: `deploy/coordinator.yaml` (non-root, read-only root, capabilities dropped, PVC for `/data`, pinned commit, Ingress for `roloe.cnh.radarhq.io`) and `deploy/argocd-application.yaml`.
- Open (needs the join code): the deploy, an Argo Rollouts canary gated on Dash0, the HPA, Radar's audit and AI SRE.

## Guest-path rehearsals



## Guest path readiness

Zero-install guest meetings against Elastic Cloud Serverless, with Weston's card (from today's Roloe work) answered by his own Claude Code (Sonnet, headless, his login on his Mac). Each run: cold page load, the guest submits, Weston's assistant was already waiting. Repos used are public and not ours. `node scripts/guest-rehearsal.mjs` reproduces it.

| Run set | Public repo (p-retry) | Monorepo folder (next.js `packages/next/src/lib`) | Docs page (nodejs.org) | One sentence | Skip |
| --- | --- | --- | --- | --- | --- |
| 1 | pass · 14.5 s · nothing strong | pass · 18.7 s · nothing strong | pass · 15.9 s · nothing strong | pass · 14.3 s · 1 finding | pass · 5.9 s · nothing strong |
| 5 | pass · 20.1 s · 2 findings | pass · 29.1 s · 2 findings | pass · 19.1 s · 2 findings | pass · 14.1 s · 3 findings | pass · 16.1 s · 1 finding |
| 6 | pass · 20.1 s · 1 finding | pass · 24.1 s · 1 finding | pass · 19.7 s · 3 findings | pass · 14.0 s · 3 findings | pass · 9.0 s · 1 finding |

Times are from the guest pressing Send to findings on their page. The page opens in 2–16 ms; the meeting is prepared behind it.

What the runs found and fixed (each test-first):
- Opening took 3–14 s (the trace showed the card copy with ELSER inference). Now the guest's page answers at once.
- Findings were mostly "nothing strong" because 40 of Weston's passages were searched against one guest sentence. Now the guest's material is the query over Weston's whole card.
- GitHub's API allows 60 unauthenticated calls an hour per IP, shared by everyone at a venue. Repos are now read from the tarball, with a tree-walk fallback for folders deep in huge monorepos.
- A stalled download could hang a meeting. There's now a hard 12 s cap; the meeting always opens.
- An assistant could answer a stale meeting first. Now: oldest unanswered meeting from the last 10 minutes.
- Privacy: an assistant's prose while answering meetings restates guests' material, and was going onto the owner's card. The indexer now skips it.

Restart while a guest waits: meeting opened, coordinator restarted, then the page and card answered 200, Weston's assistant answered 19 s later, and the guest's page showed 3 findings at the same URL (Elastic Serverless).

## Guest Try it on a real public repo

A guest gave `https://github.com/sindresorhus/p-retry` (not ours). Weston's assistant posted 2 findings, one with an 18-line change to the guest's files, 17.1 s after Send. The literal diff appeared on the guest's page; on approval, Weston's laptop shallow-cloned the repo, applied the change, installed from the lockfile, and ran p-retry's own suite with `--network none`: **132 tests passed, 0 failed**, 63 s from approval to green.

What rehearsing it found and fixed, test-first:
- MCP servers can start with no `PATH`, so `git` and `docker` were missing inside Weston's assistant's server and the clone failed silently. The server now sets a safe `PATH` at startup.
- Two runners for one owner (the MCP server and `roloe guest-try`) collided on the same clone. Jobs are now claimed at the coordinator (`preparing`, `installing`); a stale claim expires after two minutes.
- From Gitar's review: a re-prepared change runs only if its diff equals the one the guest approved; clones are removed after a decline, Stop or restart; the dependency install runs with no capabilities, no privilege gain and a read-only root, with its own package cache.

## Found by Dash0, fixed in a PR

- **Agent0's conclusion:** [evidence/dash0-agent0-diagnosis.jpg](evidence/dash0-agent0-diagnosis.jpg) and its patch notes [evidence/dash0-agent0-patch.jpg](evidence/dash0-agent0-patch.jpg). No repository was connected; it searched GitHub, found this public repo, cloned it, wrote a patch and ran the suite before answering.
- **Symptom (Dash0):** Dash0's live insights flagged slow Elasticsearch queries on `roloe-coordinator` (p95 about 1.5 s). Agent0's investigation found each meeting firing about 22 separate searches, plus bulks and an msearch, and some setup calls arriving as standalone traces with no parent.
- **Span:** with each Elasticsearch call a child span of its meeting step (added in #16), the trace showed `roloe.pull` making one `_search` per passage (16) and each `roloe.finding.check` making one or two more.
- **Fix:** `store.getMany` fetches every passage of a pull, and every citation and "about" of a post, in one request. The guest's link read now starts the meeting's trace instead of being an orphan.
- **Before → after** (same rehearsal coordinator, Elastic Cloud Serverless, measured from the exported spans):

| Per meeting | Before (4 meetings) | After (3 meetings) |
| --- | --- | --- |
| Elasticsearch requests | 25 | 7 |
| `roloe.pull` p50 / p95 | 662 / 1,362 ms | 153 / 247 ms |
| `roloe.findings` p50 / p95 | 873 / 2,435 ms | 257 / 281 ms |
