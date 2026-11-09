---
title: "Scrubber and gate changes need a test change"
description: "Privacy code changes land with a test that pins the new behaviour"
type: check
when: "PRs that modify src/scrub.mjs, src/gate.mjs, src/guest-input.mjs or src/indexer.mjs without modifying any file under test/"
actions: "Post a comment asking for a failing-then-passing test that covers the change"
---

# Scrubber and gate changes need a test change

These files decide what can leave someone's machine. The project works test-first: every change here arrives with a test that failed before it. If a PR changes them and touches no test, ask for one.
