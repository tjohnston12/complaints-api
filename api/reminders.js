// api/reminders.js — complaints-api (Vercel Cron)
//
// Weekly nudge: any complaint still in "Todo" that is assigned to someone and older
// than REMINDER_DAYS gets its assignee an email digest of their open items. Keeps
// running weekly until each is moved off Todo (In progress / Done / No Follow Up),
// so nothing assigned quietly rots. No per-record "last reminded" field needed —
// the weekly cadence IS the throttle.
//
// Schedule: Vercel Cron (see vercel.json) hits GET /api/reminders. Secured by
// CRON_SECRET (Vercel auto-sends `Authorization: Bearer $CRON_SECRET` on cron runs).
// Manual test: /api/reminders?secret=<CRON_SECRET>[&dry=1]   (dry=1 = don't send, just report)
//
// Env: AIRTABLE_PAT (read Complaints + Employees bases), AIRTABLE_BASE, COMPLAINTS_TABLE,
//      EMP_BASE / EMP_TABLE, RESEND_API_KEY + ASSIGN_FROM + COMPLAINTS_APP_URL,
//      REMINDER_DAYS (default 7), CRON_SECRET.

const PAT   = process.env.AIRTABLE_PAT;
const BASE  = process.env.AIRTABLE_BASE || 'app6PnSWS8BMnGbPe';
const TABLE = process.env.COMPLAINTS_TABLE || 'tblDuAOQ7ay26FmIa';
const EMP_BASE  = process.env.EMP_BASE  || 'appraSoUXoTbhroG6';
const EMP_TABLE = process.env.EMP_TABLE || 'tblUfWrGjHTHXszos';

const RESEND_KEY  = process.env.RESEND_API_KEY;
const ASSIGN_FROM = process.env.ASSIGN_FROM || 'MRDC Complaints <noreply@mrdc-htra.com>';
const APP_URL     = process.env.COMPLAINTS_APP_URL || 'https://www.mrdc-htra.com/complaints/';
const REMINDER_DAYS = Number(process.env.REMINDER_DAYS || 7);
const CRON_SECRET   = process.env.CRON_SECRET;

const F = {
  date:       'fldrjyRR3Q7BZcLtS',
  status:     'fldEo8P4pVdtdsTHA',
  assignedTo: 'fldAsN8rlCHRumzFW',
  person:     'fldlGhp2DPw7ZcD2E',
  reason:     'fldH75Px7shL3Cv9n',
};
const EF = { name: 'fldtLjh72SJV8Uyfb', email: 'fldBggHLMX7abWiSK' };

async function airtable(path, options = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.error?.message || `Airtable ${res.status}`); e.status = res.status; throw e; }
  return json;
}

const arr = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const sel = v => (v && typeof v === 'object' ? v.name : v) || '';
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function daysSince(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d)) return 0;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

async function fetchOpenAssigned() {
  const out = [];
  let offset;
  do {
    const qs = new URLSearchParams();
    qs.set('pageSize', '100');
    qs.set('returnFieldsByFieldId', 'true');
    ['date', 'status', 'assignedTo', 'person', 'reason'].forEach(k => qs.append('fields[]', F[k]));
    if (offset) qs.set('offset', offset);
    const page = await airtable(`${BASE}/${encodeURIComponent(TABLE)}?${qs}`);
    for (const rec of (page.records || [])) {
      const f = rec.fields || {};
      const status = sel(f[F.status]) || 'Todo';
      const assignee = sel(f[F.assignedTo]);
      if (status !== 'Todo' || !assignee) continue;         // only open + assigned
      const age = daysSince(f[F.date]);
      if (age < REMINDER_DAYS) continue;                    // not overdue yet
      out.push({ id: rec.id, person: f[F.person] || '(no name)', reason: arr(f[F.reason]).map(sel), date: f[F.date] || '', age, assignee });
    }
    offset = page.offset;
  } while (offset);
  return out;
}

async function lookupEmployeeEmail(name) {
  if (!name) return '';
  try {
    const qs = new URLSearchParams();
    qs.set('maxRecords', '1');
    qs.set('returnFieldsByFieldId', 'true');
    qs.append('fields[]', EF.name);
    qs.append('fields[]', EF.email);
    qs.set('filterByFormula', `{Name}='${String(name).replace(/'/g, "\\'")}'`);
    const j = await airtable(`${EMP_BASE}/${encodeURIComponent(EMP_TABLE)}?${qs}`);
    const r = (j.records || [])[0];
    return r ? (r.fields[EF.email] || '') : '';
  } catch (_) { return ''; }
}

function digestHtml(assignee, items) {
  const rows = items.map(it => {
    const link = APP_URL + (APP_URL.indexOf('?') >= 0 ? '&' : '?') + 'id=' + encodeURIComponent(it.id);
    const type = it.reason.join(', ') || '—';
    return `<tr>` +
      `<td style="padding:8px 10px;border-bottom:1px solid #eee"><a href="${esc(link)}" style="color:#1E2B5E;font-weight:600;text-decoration:none">${esc(it.person)}</a><div style="color:#6B6B6B;font-size:12px">${esc(type)}</div></td>` +
      `<td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;white-space:nowrap">${esc(it.date || '—')}</td>` +
      `<td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;white-space:nowrap;color:#A32D2D;font-weight:600">${it.age} days</td>` +
      `</tr>`;
  }).join('');
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1a1a1a;max-width:600px">` +
    `<div style="background:#1E2B5E;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;border-bottom:3px solid #C9A84C">` +
    `<div style="font-size:17px;font-weight:600">Complaints awaiting your action</div></div>` +
    `<div style="border:1px solid #DDD9D0;border-top:none;border-radius:0 0 10px 10px;padding:16px 18px">` +
    `<p style="margin:0 0 12px">Hi ${esc(assignee)}, ${items.length === 1 ? 'this complaint is' : 'these ' + items.length + ' complaints are'} assigned to you and still open (Todo) after ${REMINDER_DAYS}+ days:</p>` +
    `<table style="border-collapse:collapse;width:100%;font-size:14px;margin:0 0 14px">` +
    `<tr style="text-align:left;color:#6B6B6B;font-size:12px;text-transform:uppercase;letter-spacing:.04em">` +
    `<th style="padding:0 10px 6px">From</th><th style="padding:0 10px 6px">Received</th><th style="padding:0 10px 6px">Open</th></tr>` +
    rows + `</table>` +
    `<a href="${esc(APP_URL)}" style="display:inline-block;background:#1E2B5E;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px">Open the Complaints app &rarr;</a>` +
    `<p style="color:#6B6B6B;font-size:12px;margin:14px 0 0">You'll stop getting reminded about an item once you move it out of "Todo" (In progress / Done / No Follow Up Required).</p>` +
    `</div></div>`;
}

async function sendDigest(assignee, items) {
  if (!RESEND_KEY) return { assignee, count: items.length, sent: false, reason: 'no RESEND_API_KEY' };
  const to = await lookupEmployeeEmail(assignee);
  if (!to) return { assignee, count: items.length, sent: false, reason: 'no email on record' };
  const subject = `Reminder: ${items.length} complaint${items.length === 1 ? '' : 's'} awaiting your action`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ASSIGN_FROM, to: [to], subject, html: digestHtml(assignee, items) }),
    });
    return { assignee, count: items.length, sent: r.ok, reason: r.ok ? '' : `Resend ${r.status}` };
  } catch (e) { return { assignee, count: items.length, sent: false, reason: e.message }; }
}

module.exports = async function handler(req, res) {
  if (!PAT) return res.status(500).json({ error: 'Server not configured (AIRTABLE_PAT missing)' });

  // Auth: Vercel cron sends `Authorization: Bearer $CRON_SECRET`; manual test via ?secret=
  const provided = (req.query?.secret) || String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (CRON_SECRET && provided !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });

  const dry = String(req.query?.dry || '') === '1';

  try {
    const overdue = await fetchOpenAssigned();
    // group by assignee
    const byAssignee = {};
    for (const it of overdue) (byAssignee[it.assignee] = byAssignee[it.assignee] || []).push(it);

    const results = [];
    for (const [assignee, items] of Object.entries(byAssignee)) {
      items.sort((a, b) => b.age - a.age);
      results.push(dry ? { assignee, count: items.length, sent: false, reason: 'dry run' } : await sendDigest(assignee, items));
    }
    return res.status(200).json({
      ok: true,
      reminderDays: REMINDER_DAYS,
      overdueTotal: overdue.length,
      assignees: results.length,
      dry,
      results,
    });
  } catch (e) {
    console.error('[complaints reminders]', e.message);
    return res.status(e.status || 500).json({ error: e.message || 'Server error' });
  }
};
