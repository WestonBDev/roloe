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
- Open: `.gitar/rules/` workflow rules; a genuine red CI run fixed through Gitar's auto-apply.

## Elasticsearch: the data layer and the privacy boundary

- Elastic Cloud Serverless 9.7 project. The RRF retriever (BM25 + `semantic_text` on `.elser-2-elastic`) runs overlap retrieval at every meeting.
- Scoped keys: Serverless refuses to derive a key with privileges from an API key. Its own words: *"creating derived api keys requires an explicit role descriptor that is empty (has no privileges)"*. So scope is the coordinator's `encounter_id` filter on every read, and the coordinator says so from startup. On a licensed cluster with user credentials, each meeting gets a document-level-security key (`scripts/elastic-check.mjs` prints the live mode and a raw no-filter proof).
- Stop sends the old key back to Elasticsearch and records its answer (0 documents).
- Open: encounter state and counts in Elastic (needed for the HPA); Agent Builder tools and Workflows (availability on Serverless to be checked); a "why this passage" view.

## Dash0: traces and metrics from the first route

- Every request is a span; every meeting is one trace (`roloe.tap`, `roloe.overlap`, `roloe.guest_read`, `roloe.pull`, `roloe.findings`, `roloe.finding.check`, `roloe.try`, `roloe.probe`, `roloe.stop`). Attributes are IDs, counts and per-meeting HMACs, never text.
- Metrics: `roloe.meetings`, `roloe.findings`, `roloe.help`, `roloe.time_to_help` (seconds; 120 s bucket for the SLO), `roloe.time_to_findings`. `scripts/otlp-check.mjs`: Dash0 accepted both a trace and a metric batch.
- Found with traces: the guest page's "Opening…" took 3–14 s; the `roloe.tap` span showed copying 305 passages (with ELSER inference) took 3.2–4.4 s. Fix: the guest page now answers at once and the meeting is prepared behind it (2–16 ms).
- Open: logs, browser RUM, the SLO and dashboard set up in Dash0, an Agent0 diagnosis.

## Radar / Argo CD

- Manifests ready: `deploy/coordinator.yaml` (non-root, read-only root, capabilities dropped, PVC for `/data`, pinned commit, Ingress for `roloe.cnh.radarhq.io`) and `deploy/argocd-application.yaml`.
- Open (needs the join code): the deploy, an Argo Rollouts canary gated on Dash0, the HPA, Radar's audit and AI SRE.

## Guest-path rehearsals

See [Guest path readiness](#guest-path-readiness) below.
