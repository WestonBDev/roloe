// The assistant's instructions must describe a change in the exact shape roloe_post_findings accepts,
// or a malformed change is refused and the assistant drops it: no Try it on the guest's phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';
import { instructions } from '../src/coordinator.mjs';

test('a guest with a repo: the change is in the tool\'s shape, expected on the first finding, code over docs', () => {
  const t = instructions('Weston', 'Maya', { guest: true, guestRepo: true });
  assert.match(t, /change: \{"edits": \[\{"file"/, 'the tool\'s own shape');
  assert.doesNotMatch(t, /as \{file, find, replace\}/, 'never the bare shape the tool refuses');
  assert.match(t, /first finding/i);
  assert.match(t, /not a README|not .*docs/i);
  assert.match(t, /tests/);
});

test('a pair meeting describes the same shape', () => {
  const t = instructions('Weston', 'Maya');
  assert.match(t, /change \(\{"edits": \[\{"file"/);
});

test('a guest without a repo is not asked for a change', () => {
  assert.doesNotMatch(instructions('Weston', 'Maya', { guest: true }), /"edits"/);
});
