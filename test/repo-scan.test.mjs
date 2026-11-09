// CI hygiene: no tracked file may contain a secret-shaped string (Roloe's own scrubber patterns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from '../scripts/repo-scan.mjs';

test('flags secret-shaped literals with file and line; runtime-assembled fakes pass', () => {
  const bad = `const t = 'ghp_${'A'.repeat(36)}';\nok line\n`;
  assert.deepEqual(scanText('x.mjs', bad).map((f) => [f.file, f.line, f.kind]), [['x.mjs', 1, 'github token']]);
  assert.deepEqual(scanText('y.mjs', "const t = 'ghp_' + 'A'.repeat(36);\n"), []);
  assert.deepEqual(scanText('README.md', 'Set `ELASTIC_API_KEY=` in .env\n'), []);
});
