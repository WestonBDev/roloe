# Roloe review instructions

Roloe makes promises about privacy and safety. Review every change against them, and flag any change that breaks one, even if it works.

1. **Shared content never reaches logs or telemetry.** Spans, logs and metrics carry IDs, counts, sizes and per-encounter HMACs only, never passage text, findings text, quotes or diffs.
2. **The coordinator never holds a credential and never runs a model.** No Anthropic or OpenAI API keys, no stored claude.ai or ChatGPT logins or tokens, no `claude setup-token`, no driving another person's assistant.
3. **Every read is scoped to one encounter.** Every query against shared passages filters by `encounter_id`, or uses that encounter's scoped key. Flag any query without it.
4. **Findings must cite.** A finding is accepted only if its citation resolves to a passage from the giver inside the encounter, and its quote appears verbatim in that passage. That check is code, not a prompt.
5. **The egress gate runs before anything leaves.** Outgoing findings pass the secret and canary check.
6. **Try it is sandboxed.** Tests run in a container with `--network none`, no credentials or environment variables, and no home-directory mount, on a throwaway copy that is deleted afterwards. The approval screen shows the literal diff.
7. **Stopping really stops.** Stopping an encounter revokes its key, or blocks its reads, and deletes its passages.

Also review for ordinary bugs, and keep comments short and concrete.
