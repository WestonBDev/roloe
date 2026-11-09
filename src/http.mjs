// Tiny router on plain node:http. Every request gets a span named by its route template.
import { SpanStatusCode } from '@opentelemetry/api';
import { requestSpan, logEvent } from './telemetry.mjs';

export class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

export function router() {
  const routes = [];
  const add = (method, path, handler) => {
    const names = [];
    const re = new RegExp('^' + path.replace(/:[a-zA-Z_]+/g, (m) => { names.push(m.slice(1)); return '([^/]+)'; }) + '$');
    routes.push({ method, path, re, names, handler });
  };
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = routes.find((r) => (r.method === req.method || (r.method === 'GET' && req.method === 'HEAD')) && r.re.test(url.pathname));
    const span = requestSpan(req.method, route ? route.path : 'unmatched');
    try {
      if (!route) throw new HttpError(404, 'not_found', 'Not found');
      const m = url.pathname.match(route.re);
      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      await route.handler({ req, res, url, params, query: url.searchParams, span });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: e.code || e.name || 'error' });
        console.error('[roloe]', req.method, route?.path, e.code || e.name, status === 500 ? e.message : '');
        logEvent('http.server_error', { span, severity: 'ERROR', attrs: { 'http.route': route?.path || 'unmatched', 'error.type': e.code || e.name || 'error' } });
      }
      if (!res.headersSent) send(res, status, { error: e.code || 'error', message: status >= 500 ? 'Something went wrong on the coordinator.' : e.message });
    } finally {
      span.setAttribute('http.response.status_code', res.statusCode);
      span.end();
    }
  };
  return { add, handle, routes };
}

export function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  res.writeHead(status, {
    'content-type': isBuf ? (headers['content-type'] || 'text/plain; charset=utf-8') : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}

export async function readJson(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too_large', 'Request too large');
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'bad_json', 'Body must be JSON'); }
}

export function bearer(req, query) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return '';
}
export function sideKey(req, query) {
  return (req.headers['x-roloe-key'] || query?.get('k') || '').toString();
}
