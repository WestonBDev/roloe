---
title: "Try it stays sandboxed"
description: "Tests run with no network, no credentials, no home mount, on a throwaway copy, after the literal diff is approved"
type: check
when: "PRs that change src/tryit.mjs, src/tryit-ui.mjs or src/guest-try.mjs"
actions: "Post an inline comment on any docker invocation missing --network none (test run), --read-only, --cap-drop ALL, no-new-privileges or --user, on any host env or home folder reaching the container, and on any path that runs code before approval"
---

# Try it stays sandboxed

The test container runs `--network none --read-only --cap-drop ALL --security-opt no-new-privileges --user <uid:gid>` with only the copy mounted. The install container keeps the network but is otherwise as locked down. Only the diff the person approved may run, and the copy is deleted afterwards.
