// Test harness: a coordinator on a random port with a throwaway data dir.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ROLOE_DATA_DIR = mkdtempSync(join(tmpdir(), 'roloe-test-'));
process.env.ROLOE_ENV_FILE = '/nonexistent';
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
delete process.env.ES_URL;
delete process.env.ELASTIC_URL;

export async function startTestServer() {
  const http = await import('node:http');
  const { buildApp } = await import('../src/coordinator.mjs');
  const app = buildApp();
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  return { base, call, close: () => new Promise((r) => server.close(r)), dataDir: process.env.ROLOE_DATA_DIR };
}
