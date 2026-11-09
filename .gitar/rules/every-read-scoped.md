---
title: "Every read is scoped to one meeting"
description: "Reads of shared passages go through the meeting's key or the encounter_id filter"
type: check
when: "PRs that change src/store/ or any route in src/coordinator.mjs that reads passages"
actions: "Post an inline comment on any query of shared passages that lacks the encounter_id filter or the meeting's key"
---

# Every read is scoped to one meeting

Each store read takes a key ID (`get`, `getMany`, `list`, `search`, `msearch`, `count`) and applies the `encounter_id` filter. Card-level reads (`listCard`, `replaceCard`, `removeFromCard`) are owner-only and must stay behind the card key. Flag any new store method or Elasticsearch query that can return passages from more than one meeting.
