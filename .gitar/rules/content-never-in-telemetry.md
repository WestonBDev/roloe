---
title: "Shared content never reaches telemetry"
description: "Spans, logs and metrics carry IDs, counts, sizes and per-meeting HMACs only"
type: check
when: "PRs that change src/telemetry.mjs, src/metrics.mjs, or add or change span, log or metric attributes anywhere in src/"
actions: "Post an inline comment on any attribute that could carry passage text, a quote, a finding, a diff, a link, or a name, and ask for an ID, count or HMAC instead"
---

# Shared content never reaches telemetry

Roloe promises that Dash0 sees the shape of a meeting, never its content. Check every new or changed `setAttribute`, `setAttributes`, `clean({...})`, metric attribute and log field. Allowed: IDs, counts, sizes, durations, states, enum labels and `hmac(...)` values. Not allowed: passage text, quotes, `what`, diffs, URLs a guest gave, owner or guest names, card keys.
