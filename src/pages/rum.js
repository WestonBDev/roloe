// Dash0 real-user monitoring for the phone pages. It reports page loads, web vitals, errors and
// request timings, through our coordinator (/rum), never straight to Dash0, so no token ships here.
// URLs are reduced to their shape first: no query, no fragment, no meeting IDs, no handles.
import { init } from '/vendor/dash0.js';

const shape = (p) => String(p || '')
  .replace(/^\/(e|stage)\/e-[0-9a-f]{10}/, '/$1/:id')
  .replace(/^\/api\/e\/e-[0-9a-f]{10}/, '/api/e/:id')
  .replace(/^\/(g|q|c)\/[^/]+/, '/$1/:owner')
  .replace(/^\/api\/(cards|g)\/[^/]+/, '/api/$1/:owner');

function urlAttributeScrubber(attrs) {
  const out = { ...attrs };
  delete out['url.query'];
  delete out['url.fragment'];
  if (out['url.path']) out['url.path'] = shape(out['url.path']);
  return out;
}

if (!location.pathname.startsWith('/me/')) {
  try {
    init({
      serviceName: 'roloe-web',
      endpoint: { url: `${location.origin}/rum`, authToken: 'proxied-by-roloe' },
      urlAttributeScrubber,
      ignoreUrls: [/\/rum\//],
      pageViewInstrumentation: { trackVirtualPageViews: false, includeParts: [] },
    });
  } catch { /* monitoring must never break the page */ }
}
