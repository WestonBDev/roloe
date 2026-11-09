// Configuration. Reads .env (git-ignored) when present; real values are pasted there by the owner.
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const envFile = process.env.ROLOE_ENV_FILE || join(ROOT, '.env');
if (existsSync(envFile)) {
  try { process.loadEnvFile(envFile); } catch { /* malformed .env: ignore, defaults apply */ }
}

const port = Number(process.env.PORT || 7420);

export const config = {
  port,
  host: process.env.HOST || '0.0.0.0',
  publicUrl: (process.env.ROLOE_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  dataDir: process.env.ROLOE_DATA_DIR || join(ROOT, 'data'),
  // Elastic Cloud values (.env) win over the local practice cluster (ES_*).
  esUrl: process.env.ELASTIC_URL || process.env.ES_URL || '',
  esUser: process.env.ELASTIC_URL ? (process.env.ELASTIC_USER || 'elastic') : (process.env.ES_USER || 'elastic'),
  esPassword: process.env.ELASTIC_URL ? (process.env.ELASTIC_PASSWORD || '') : (process.env.ES_PASSWORD || ''),
  esApiKey: process.env.ELASTIC_URL ? (process.env.ELASTIC_API_KEY || '') : '',
  esIndex: process.env.ES_INDEX || 'roloe-passages',
  esInference: process.env.ES_INFERENCE_ID || '',   // semantic model for a NEW index, e.g. .jina-embeddings-v5-text-small
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '',
  dash0Token: process.env.DASH0_AUTH_TOKEN || '',
  dash0Dataset: process.env.DASH0_DATASET || '',
  traceFile: process.env.ROLOE_TRACE_FILE || '',
};
