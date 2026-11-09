import { $, api, esc, hhmm, poll } from '/roloe.js';
const tiles = [['meetings', 'Meetings'], ['help_that_worked', 'Help that worked', 'ok'], ['findings_accepted', 'Findings accepted'], ['nothing_strong', 'Nothing strong'], ['declined', 'Declined'], ['failed', 'Failed'],
  ['median_tap_to_findings_s', 'Median tap → findings', '', 's'], ['median_tap_to_green_s', 'Median tap → working help', 'ok', 's'], ['findings_dropped', 'Dropped by the citation check'], ['canaries_in_telemetry', 'Canaries found in telemetry', 'ok']];
poll(async () => {
  try {
    const d = await api('/api/dashboard');
    $('#grid').innerHTML = tiles.map(([k, label, cls, unit]) => `<div class="card"><span class="tab">${esc(label)}</span><p class="n ${cls || ''}">${d[k] == null ? '–' : esc(unit ? d[k].toFixed(1) + ' s' : d[k])}</p></div>`).join('');
    $('#upd').textContent = `updated ${hhmm(d.updated)}`;
  } catch (e) { $('#upd').textContent = 'offline'; }
}, 5000);
