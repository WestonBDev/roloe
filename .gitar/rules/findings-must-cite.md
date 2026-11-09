---
title: "Findings must cite, in code"
description: "The citation, verbatim-quote and gate checks stay code, never a prompt"
type: check
when: "PRs that change src/checks.mjs, the findings route in src/coordinator.mjs, or the instructions sent to assistants"
actions: "Post a comment if any finding could be accepted without its citation resolving to the giver's passage in this meeting and its quote being verbatim"
---

# Findings must cite, in code

`checkFinding` must keep: citation resolves (with the giver as owner), quote is a verbatim substring of the cited passage (3+ words, at most 400 characters), `about` belongs to the recipient, changes stay inside the project, and the gate passes. Moving any of these into prompt text instead of code breaks the promise.
