// Tokenizing for lexical overlap. Filesystem paths and boilerplate are dropped so retrieval
// matches work, not machine layout.
const STOP = new Set(('the and for that this with you are was but not have has had from they them their what when where which while will would could should there here then than into onto over under about after before just also only very can its it\'s our out all any each one two use used using get got make made let like need want now yes okay sure some more most other such been being does did done doing your yours mine his her she him who whom why how per via etc see run runs ran file files line lines code test tests todo note notes thing things way new add added adds still really already maybe might must same well back know think going look looks looking done set sets').split(' '));

export function tokens(text) {
  return String(text || '')
    .replace(/(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)+/g, ' ')   // paths
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[removed: [^\]]+\]/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && t.length <= 30 && !STOP.has(t) && !/^\d+$/.test(t));
}

// BM25 over a small candidate set (one encounter, one owner: a few hundred passages).
export function bm25Search(docs, query, k = 5) {
  const q = [...new Set(tokens(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map((d) => d._tokens || (d._tokens = tokens(d.text)));
  const avg = toks.reduce((s, t) => s + t.length, 0) / docs.length || 1;
  const df = new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);
  const N = docs.length;
  const scored = [];
  docs.forEach((d, i) => {
    const tf = new Map();
    for (const w of toks[i]) tf.set(w, (tf.get(w) || 0) + 1);
    let s = 0;
    for (const w of q) {
      const f = tf.get(w);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * toks[i].length / avg));
    }
    if (s > 0) scored.push({ doc: d, score: s });
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}
