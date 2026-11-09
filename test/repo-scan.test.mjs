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

test('KEY=value secrets are caught too, but references and empty slots are not (Gitar)', () => {
  assert.equal(scanText('.env.example', 'ELASTIC_API_KEY=' + 'Xk29fj' + '3kLq8zQ\n')[0]?.kind, 'secret value');
  assert.deepEqual(scanText('.env.example', 'ELASTIC_API_KEY=\nDASH0_AUTH_TOKEN=\n'), []);
  assert.deepEqual(scanText('src/x.mjs', 'const k = process.env.ELASTIC_API_KEY;\n'), []);
});

test('bare SECRET=/TOKEN= and PWD/CREDENTIAL names are caught; code that reads a key is not (Gitar)', () => {
  const v = 'Xk29fj' + '3kLq8zQ';
  for (const name of ['SECRET', 'TOKEN', 'DB_PWD', 'AWS_CREDENTIAL', 'api_key']) assert.equal(scanText('.env', `${name}=${v}\n`)[0]?.kind, 'secret value', name);
  for (const line of ['const key = bearer(req);', 'const key = newKey(\'rk\');', "send(res, 201, { key: enc.sides[guest.owner].key });"]) assert.deepEqual(scanText('src/x.mjs', line), [], line);
});
