# Roloe

**A business card that brings your work. Scan, and the person in front of you gets the help you already have.**

**Keep talking. Your agents go deep.** At a conference, people keep their small talk, the human part. While they talk, Roloe has each person's own coding agent read the overlapping parts of the other's work, so both leave with the substance too: what the other person actually figured out today, in their own words, with the change and the tests to prove it. It's the agent-reviews-your-work idea, done between two people's agents, so the insight comes from someone else's real day rather than from a model's general knowledge.

## Run your card in two steps

1. **Once, on your laptop** (Node 22, git, and Claude Code or Codex logged in on your own account):

   ```bash
   git clone https://github.com/WestonBDev/roloe ~/roloe && cd ~/roloe && npm ci && node bin/roloe.mjs join --url <coordinator URL> --owner <short-name> --name "<Your Name>" --project <the project you're working on today>
   ```

2. **In your assistant, opened in that project, say once:**

   > Wait for Roloe meetings: call roloe_wait_for_tap, follow the instructions it returns, post your findings, then call it again. Keep going until I say stop.

People meet you by scanning your QR: open `/q/<short-name>` on your phone or screen. Check exactly what your card shares with `node bin/roloe.mjs show`, and keep names, clients or topics off it for good with `node bin/roloe.mjs off-limits add "<term>"`.

Built during the WeMakeDevs Cloud Native Hackathon, November 9, 2026. AI coding assistants (Claude Code and Codex) were used; I can explain every part of the architecture and the decisions behind it.

> The person next to you already fixed the thing you're stuck on. Neither of you will find out.

Someone scans your card's QR with their phone: no app, no account. They paste a public repo, a folder in one, any page, or one sentence about what they're working on. Within seconds their phone shows your best-matching words, verbatim and cited; within about a minute **your own** assistant (Claude Code, Codex, or any MCP client) has read the overlap and posted at most three findings, each credited to a real moment in your work. If a finding carries a change, they see the literal diff on their phone, approve it, and **Try it** runs their own tests in a container with no network. Two people with cards get the same both ways.

Roloe's coordinator **runs no model and never holds anyone's login or token**. Each person's assistant does the reading on that person's own subscription.

## How it was built

- **Test-first.** From the card CLI onward, every feature landed as a failing test commit (`test(red): …`) followed by the commit that makes it pass (`feat(green): …`). The first scrubber, gate and indexer tests were written right after that code, before TDD was adopted; their commit says so. `git log --oneline` shows the pairs.
- **Live or recorded.** Anything recorded rather than live during the demo is listed under [Live and recorded](#live-and-recorded).

## How it works

```mermaid
flowchart LR
  tap["Card tap · guest page<br/>QR or NFC → /g/&lt;owner&gt;"]
  subgraph W["Weston's laptop"]
    direction TB
    wa["Claude Code<br/>(own subscription)"] --> wm["Roloe MCP server + CLI<br/>roloe mcp · roloe on<br/>scrub · local egress gate"] --> wt["Try it sandbox<br/>docker --network none, no keys"]
  end
  subgraph R["Roloe services"]
    direction TB
    co["Roloe coordinator<br/>(no model, no logins)<br/>overlap · citation check · gate"]
    es["Elasticsearch<br/>(scoped per encounter)"]
    d0["Dash0 traces<br/>(IDs only, no content)"]
    co --> es
    co -.-> d0
  end
  subgraph A["Maya's laptop"]
    direction TB
    aa["Codex<br/>(own subscription)"] --> am["Roloe MCP server + CLI<br/>roloe mcp · roloe on<br/>scrub · local egress gate"] --> at["Try it sandbox<br/>docker --network none, no keys"]
  end
  tap --> co
  wm <--> co
  am <--> co
  classDef teal fill:#e2efeb,stroke:#0d6e5c,color:#16191d
  classDef purple fill:#ece7f8,stroke:#5b3fa8,color:#16191d
  class wa,wm,wt,aa,am,at teal
  class co,es,d0,tap purple
  style W fill:#f3faf8,stroke:#0d6e5c
  style A fill:#f3faf8,stroke:#0d6e5c
  style R fill:#f7f4fd,stroke:#5b3fa8
```

Teal: each person's own machine and subscription. Purple: Roloe services, no model, no credentials. The same diagram is served at `/how` for a projector.

1. **One switch.** `roloe on` indexes today's work for one project: the owner's own typed messages and the assistant's prose from today's Claude Code and Codex sessions (never tool output, never other sessions' briefs), tracked text files in ~50-line chunks, and the last 25 commits. Everything is scrubbed for secret shapes on the owner's machine and **again** on arrival. `roloe show` (or `/me/<you>`) prints exactly what is shared; anything can be kept private.
2. **Scan.** Scanning a card's QR opens `/g/<owner>`, the zero-install guest page; with your own card on the phone it offers "Meet as you". The coordinator reads what the guest gave (public https only, capped, scrubbed), copies the cards into a new encounter in Elasticsearch, opens that encounter's scope (a per-meeting document-level-security key where Elasticsearch allows minting one; on Elastic Cloud Serverless, the coordinator's `encounter_id` filter on every read), shows the guest the best-matching passage verbatim within seconds, and precomputes the overlap (about 40 of the giver's passages as queries against the recipient's, reciprocal rank fusion, top 8 with 3 slots kept for files so a finding can carry a code change).
3. **Sealed lines.** Each person may seal one line about what they expect. The browser sends only SHA-256(`nonce|line`); the line opens when the findings land.
4. **Findings.** Each assistant calls `roloe_pull` (or is woken by the tap), reads its slice, and posts at most three findings with `roloe_post_findings`. The **local egress gate** on the giver's machine blocks anything containing a value the scrubber removed from their work. The coordinator then drops, in code, any finding whose citation doesn't resolve to the giver's passage inside this encounter, whose quote isn't verbatim, whose `about` isn't the recipient's, whose change leaves the project, or that fails the gate.
5. **Try it.** `roloe try` runs on the recipient's laptop: it copies the project, applies the edits (each must match exactly once), shows the literal `git diff` on `127.0.0.1:7421`, and after approval installs dependencies from the lockfile, then runs the tests with `--network none --read-only`, no environment and no home mount. Green means exit 0 **and** at least one test ran. Only status and counts go to the coordinator.
6. **Thank-you and receipt.** The giver gets "Helped" with the real test count; each side sees which of its passages the other assistant read.
7. **Stop.** Either person can stop: the key is invalidated, the encounter's copies are deleted, and a query with the old key is run to prove it returns 0.

## Sponsor tools, and what each one carries

| Tool | What it does in Roloe |
| --- | --- |
| **Elasticsearch** | The data layer and the privacy boundary. One passage index (`owner_id`, `encounter_id`, `kind`, `speaker`, `ts`, `shared_at`, `text`, and two `semantic_text` fields: `text_semantic` on `.elser-2-elastic` and `text_jina` on `.jina-embeddings-v5-text-small`). Cards are copied into each meeting with search + `_bulk?refresh=true`; overlap retrieval fuses three rankings (BM25, ELSER, and multilingual Jina) with the `rrf` retriever over `_msearch`, each ranking filtered to the meeting; a pull or a post fetches its passages in one request. ELSER is English-only, so the Jina field is what lets a guest write in their own language and still find English work. A second index, `roloe-meetings`, holds one metadata record per meeting (`dynamic: strict`: IDs, counts, times, outcomes; never text). It feeds an **Agent Builder** organizer view: two custom ES\|QL tools and an agent restricted to them ([elastic/agent-builder/](elastic/agent-builder/)). An Elastic **Workflow**, `roloe-conference-close`, deletes meeting copies older than 12 hours on a schedule ([elastic/workflows/](elastic/workflows/)); `node scripts/elastic-setup.mjs` applies both. **Scope, honestly:** on a licensed cluster with user credentials each meeting gets an API key whose role descriptor carries document-level security (`query: {term: {encounter_id}}`). The live deployment is Elastic Cloud Serverless, where Elasticsearch refuses to derive a privileged key from an API key, so there the coordinator's `encounter_id` filter on every read is the scope; `/healthz` and the stage say which mode is live. Stop deletes the meeting's copies and records Elasticsearch's own answer to the old scope. `node scripts/elastic-check.mjs` prints the live mode, a raw no-filter proof and the cross-language proof. |
| **Dash0** | OpenTelemetry from the first route. Every request is a span; every encounter is one trace with `roloe.tap`, `roloe.overlap`, `roloe.seal`, `roloe.pull`, `roloe.findings`, one `roloe.finding.check` per finding, `roloe.try` (with `roloe.time_to_green_ms`), `roloe.probe` and `roloe.stop`. Attributes are IDs, counts, sizes and per-encounter HMACs; the HMAC key is destroyed on stop. Never text. `node scripts/otlp-check.mjs` proves export. |
| **Radar / Argo CD** | `deploy/coordinator.yaml` (non-root, read-only root, all capabilities dropped, seccomp RuntimeDefault) and `argocd/application.yaml` (automated sync, prune, self-heal). Every push to `main` builds the image to GHCR and pins it in `deploy/kustomization.yaml`; Argo CD rolls it into `team-roloe`. |
| **Gitar** | Every feature arrives as a pull request reviewed against `.gitar/review/roloe-invariants.md`: content never in telemetry, no credentials, every read scoped, findings must cite, gate before egress, sandboxed Try it, stop really stops. |

## Setup

Requirements: Node 22, git. For Try it: Docker (on a Mac, `brew install colima docker && colima start`).

### Run a coordinator

```bash
git clone https://github.com/WestonBDev/roloe && cd roloe
npm ci
cp .env.example .env    # optional: Elastic and Dash0 values; without them it uses an in-memory store and a local trace file
npm start               # http://localhost:7420
```

Set `ROLOE_PUBLIC_URL` to the address phones will use, or the QR codes point at localhost. Without `ELASTIC_URL` the coordinator uses the in-memory store behind the same interface (and says so in its log).

### Join in one command (any second person, Claude Code or Codex)

```bash
git clone https://github.com/WestonBDev/roloe ~/roloe && cd ~/roloe && npm ci && node bin/roloe.mjs join --url http://<coordinator> --owner <short-name> --name "<Your Name>" --project <path to today's project>
```

`join` turns your card on and connects whichever of Claude Code and Codex is installed (`claude mcp add --scope user roloe …`, `codex mcp add roloe …`). Then, in your assistant: *"Call roloe_wait_for_tap, then follow its instructions; repeat."*

### Or step by step: put your card on it (each person, on their own laptop)

```bash
git clone https://github.com/WestonBDev/roloe ~/roloe && cd ~/roloe && npm ci
node bin/roloe.mjs on --url http://<coordinator> --owner <short-name> --name "<Your Name>" --project <path to today's project>
node bin/roloe.mjs show     # exactly what is shared
node bin/roloe.mjs me       # your card page (keep this link to yourself: it holds your card key)
```

Your card key and the values the scrubber removed stay in `~/.roloe/<name>.json` (mode 600).

### Connect your own assistant

**Claude Code**

```bash
claude mcp add roloe -- node ~/roloe/bin/roloe.mjs mcp
claude --dangerously-load-development-channels server:roloe   # optional: taps arrive in the open session (research preview)
```

Then, in the session: *"Wait for Roloe taps and answer them."* (or after a tap: *"What do Maya and I have for each other?"*).

**Codex**

```bash
codex mcp add roloe -- node ~/roloe/bin/roloe.mjs mcp
```

Codex can't be woken from outside, so start a session in your project and say: *"Call roloe_wait_for_tap, then follow its instructions; repeat."* To skip per-call approval prompts, add `default_tools_approval_mode = "approve"` under `[mcp_servers.roloe]` in `~/.codex/config.toml`.

### Meet

```bash
node bin/roloe.mjs tap <their-name>     # or scan their card's QR: /g/<their-name>
node bin/roloe.mjs inbox                # your meeting links
node bin/roloe.mjs try                  # try a finding's change: literal diff, approve, tests with no network
node bin/roloe.mjs stop                 # end it for both sides
node bin/roloe.mjs canary               # the judge beat: a fresh secret in a file that is never shared
```

### Stay ready for a long session (judging, a booth)

A chat session has to keep calling `roloe_wait_for_tap`, and it can stop or sit on a permission prompt. For hours of scans, run this on your laptop instead:

```bash
caffeinate -dims node bin/roloe.mjs answer
```

For each new meeting on your card it starts your own Claude Code headless (your login, this laptop, at most 3 at once), told to answer that one meeting with the Roloe tools and stop. It also serves guest Try it, so keep Docker running. Guests see your assistant as online while it runs. Use it instead of a waiting chat session, not beside one.

### Deploy on the Radar cluster (Argo CD)

Every push to `main` builds the image (`.github/workflows/deploy.yaml`, to `ghcr.io/westonbdev/roloe`) and pins it in `deploy/kustomization.yaml`; Argo CD in the team cluster syncs `deploy/` to namespace `team-roloe`, served at https://roloe.cnh.radarhq.io.

```bash
scripts/k8s-secrets.sh    # creates the roloe-elastic and roloe-otel Secrets from your .env; values never enter git
```

Apply `argocd/application.yaml` once (through Radar's MCP server or kubectl) to start the sync. `ROLOE_PUBLIC_URL` (where QR codes point) lives in the Deployment in `deploy/coordinator.yaml`; change it in git and Argo CD rolls the pod. `AGENTS.md` and `.agents/skills/` tell a coding agent how to ship and debug through Radar.

### Tests

```bash
npm test                                            # 38 tests: in-memory store, Docker tests skip if Docker is absent
set -a; . ~/roloe-elastic/es.env; set +a; npm test  # also runs the store contract against a real Elasticsearch
```

## Dash0: traces, counts and the time-to-help SLO

Traces and metrics go to Dash0 over OTLP (`node scripts/otlp-check.mjs` sends one of each and prints whether Dash0 accepted them).

| Metric | Type | Attributes | Used for |
| --- | --- | --- | --- |
| `roloe.meetings` | counter | `kind`: pair, guest, same_person | counts dashboard |
| `roloe.findings` | counter | `outcome`: accepted, dropped, nothing_strong | counts dashboard |
| `roloe.help` | counter | `outcome`: passed, failed, declined, did-not-apply | counts dashboard |
| `roloe.time_to_help` | histogram, seconds, buckets 10…600 incl. **120** | none | **SLO** |
| `roloe.time_to_findings` | histogram, seconds | none | counts dashboard |

**SLO: time to working help.** 90% of meetings that reach a passing Try it get there within 120 s of the tap. Good events are `roloe.time_to_help` observations in the `le=120` bucket; total events are all observations. In Dash0's query builder the series appear under `otel_metric_name="roloe.time_to_help"`; pick the bucket and count series there, as the exact PromQL names depend on Dash0's mapping. The same numbers are on the coordinator's own `/dashboard` page.

## Pages

| Route | Who | What |
| --- | --- | --- |
| `/g/<owner>` | Anyone who scans the card | Paste a link or skip; "Tap as you" if this phone holds your card |
| `/e/<id>?k=` | Each person | Seal or skip, keep talking, findings dealt one at a time, what you each expected, thank-you, receipt, Stop; guests also get the extraction attempt |
| `/stage/<id>?k=` | Projector | Clock to green, sealed lines, one finding per side, Try it line, Prepared before / Read live strip; `&recorded=<id>&rk=<key>` for the labelled fallback after 1:40 (`&cutoff=` seconds to rehearse) |
| `/me/<owner>#<key>` | Card owner | The switch, totals, every shared passage with Keep private |
| `/dashboard` | Anyone | Meetings, help that worked, nothing strong, declined, failed, medians, canaries in telemetry |
| `/how` | Projector | The architecture: each person's own laptop and subscription, and Roloe's services |
| `/c/<owner>` | Print | 85 × 55 mm card, front and back with QR |

## Fallbacks, all labelled

- **Any second person.** `roloe join` works for anyone with Claude Code or Codex, not one particular partner.
- **No second person.** A judge's zero-install tap (`/g/<owner>`: paste a link, a finding lands, then the extraction attempt) runs live with only the owner enrolled.
- **Recorded.** Every meeting keeps its record (times, findings, Try it result). The stage replays one on its own real clock with `&replay=1`, or switches to one automatically at 1:40 with `&recorded=<id>&rk=<stage key>`; either way the screen says **Recorded HH:MM**.
- **Same person, two projects.** As a last resort, `roloe on --owner <you>-two --project <other project> --same-person-as <you>` makes a second card. It needs your first card's key, and every screen labels the pair "same person, two projects".

## Accessibility

Even if conversation is hard for you (a loud hall, a second language, neurodivergent, introverted), you still leave with the substance: in text, on your own phone, at your own pace.

- **Phone only, one hand.** The guest path is a single page: one text box or one link, Send. Buttons are at least 44 px; inputs are 16 px or more so phones don't zoom; nothing scrolls sideways.
- **Readable at arm's length.** Large type on ruled cards; the QR page is black on white, full screen, with the short URL under it.
- **No time pressure.** Nothing expires while you read. Your meeting stays at the same link, and every card you scanned is filed in your Roloe on that phone (`/r`).
- **Screen readers.** Pages use real headings, labelled inputs and buttons, live regions for arriving findings, and words alongside every colour.
- **Reduced motion.** `prefers-reduced-motion` turns every animation off; sound is optional.

## Evidence

One line per thing the judges asked for; details in [docs/evidence.md](docs/evidence.md).

- **Gitar:** every feature arrived as a reviewed PR ([#1](https://github.com/WestonBDev/roloe/pull/1) to [#20](https://github.com/WestonBDev/roloe/pull/20)); every Gitar finding was fixed test-first in a commit marked "(Gitar)". Review instructions: [.gitar/review/](.gitar/review/); repository rules: [.gitar/rules/](.gitar/rules/). CI failure diagnosis on a real failure: [#19](https://github.com/WestonBDev/roloe/pull/19).
- **Dash0:** traces, metrics and the time-to-help SLO from the first route; a slowdown Dash0's Agent0 diagnosed ([docs/evidence/dash0-agent0-diagnosis.jpg](docs/evidence/dash0-agent0-diagnosis.jpg)), fixed in [#17](https://github.com/WestonBDev/roloe/pull/17) (Elasticsearch requests per meeting 25 → 7; pull p95 1.36 s → 0.25 s).
- **Elastic:** hybrid retrieval in any language (BM25 + ELSER + Jina, fused by RRF) and per-meeting scope on Elastic Cloud Serverless; an Agent Builder organizer view over meeting metadata only; a Workflow that deletes meeting copies after the event. Proof and limits in [docs/evidence.md](docs/evidence.md#elasticsearch-the-data-layer-and-the-privacy-boundary) and [docs/elastic-agent-builder-and-workflows.md](docs/elastic-agent-builder-and-workflows.md).
- **Radar:** deployed by Argo CD to `team-roloe`; Checks before ([docs/evidence/radar-checks-before.jpg](docs/evidence/radar-checks-before.jpg)) and an AI investigation of a rollout ([docs/evidence/radar-investigation-rollout.jpg](docs/evidence/radar-investigation-rollout.jpg)).
- **The product:** 10 of 10 rehearsed guest meetings (repo, monorepo folder, page, sentence, skip) with findings in 9–29 s; guest Try it ran a real public repo's 132 tests green with no network.

## Live and recorded

- Live: everything in the demo is live unless the stage shows the **Recorded** label, which appears only if the live cross-read isn't finished at 1:40.
- Recorded runs and their times are listed here before submission.

## Measured today

| What | Where | Result |
| --- | --- | --- |
| Guest meetings, 5 kinds of input, twice in a row | Elastic Cloud Serverless, Weston's card, his Claude Code (Sonnet) | 10 of 10 with findings; Send → findings 9–29 s; page opens in under 20 ms |
| Their words, instantly | same | Send → best-matching passage on the phone in 3.3–4.1 s |
| Guest Try it | a public repo (p-retry), Docker with `--network none` | 132 tests passed, 63 s from approval |
| Restart mid-meeting | same | page and card back; findings arrived at the same link |
| Elasticsearch per meeting, before → after #17 | exported spans | 25 → 7 requests; pull p95 1,362 → 247 ms |

## Known limits

- **Already-read passages can't be recalled.** Stop deletes the encounter's copies and revokes its key; it can't recall what an assistant already read, which may remain in that person's session history and with their model provider.
- **Scope on Elastic Cloud Serverless and Basic.** Serverless authenticates with an API key, and Elasticsearch refuses to derive a key with privileges from one ("creating derived api keys requires an explicit role descriptor that is empty"); on a Basic license, document-level security is refused. In both cases the coordinator's `encounter_id` filter (applied on every read in every mode) carries scope, and the stage says which mode is live.
- **One replica.** The coordinator holds encounter keys in memory and its records on one volume, so it runs as a single replica; a restart keeps cards and records but ends open encounters' reads. Scaling out needs that state moved into Elasticsearch.
- **The Claude Code channel is a research preview** (`--dangerously-load-development-channels`); without it, the assistant waits on `roloe_wait_for_tap` like Codex.
- **Mobile assistant connectors are untested.** Guests use the browser page.
- **Quotes from code.** When a giver's best passage is code, the quote is code (shown in mono), not their typed words; the label says whose words it is.

## License

Apache-2.0. See [LICENSE](LICENSE).
