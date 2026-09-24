// api/complaints.js — complaints-api (Vercel)
//
// Backend for the MRDC Complaints / Compliments app (www.mrdc-htra.com/complaints/).
// Reads/writes the "Complaints / Compliments" table in the dedicated base. NO deps.
//
// GET  /api/complaints                 -> { rows: [...] } newest first
// GET  /api/complaints?id=<rec>        -> { row }
// GET  /api/complaints?meta=1          -> { choices: { assignees, reasons, statuses, channels } }
// POST /api/complaints                 -> create (body = field values) -> { row }
// PATCH /api/complaints { id, ... }    -> update (assign / status / action / any field) -> { row }
// POST /api/complaints { action:'upload', id, filename, contentType, data(base64) } -> attach a file
//
// Reads (GET) are open to anyone with a Complaints session. Writes (POST/PATCH/upload)
// require a "work records" role, delivered as x-app-role from the SSO session:
// Admin / Manager / Patroller/Supervisor can write; User is read-only. See canWrite() below.
//
// Env: AIRTABLE_PAT (read+write to the Complaints base, AND read on the Employees base
//      for the live assignee list + assignee emails), AIRTABLE_BASE, COMPLAINTS_TABLE,
//      EMP_BASE / EMP_TABLE (Employees directory, defaults below).
//      RESEND_API_KEY + ASSIGN_FROM (verified sender) + COMPLAINTS_APP_URL — optional;
//      when set, assigning a complaint emails the assignee. Unset = no email, app still works.

// Calendar dates come from New Brunswick's clock, not UTC — see api/_when.js.
const { todayAtlantic } = require('./_when');

const PAT   = process.env.AIRTABLE_PAT;
const BASE  = process.env.AIRTABLE_BASE || 'app6PnSWS8BMnGbPe';
const TABLE = process.env.COMPLAINTS_TABLE || 'tblDuAOQ7ay26FmIa';

// Assignee list is drawn LIVE from the Employees directory — "anyone who works
// Complaints": org Owner, OR someone with "Complaints" in App Access AND a Complaints
// Role of Admin / Manager / Patroller/Supervisor. Requires the PAT to ALSO have
// data.records:read on the Employees base.
const EMP_BASE  = process.env.EMP_BASE  || 'appraSoUXoTbhroG6';
const EMP_TABLE = process.env.EMP_TABLE || 'tblUfWrGjHTHXszos';
const EF = { name: 'fldtLjh72SJV8Uyfb', role: 'fldWRmtEbJ6tfyLX1', appAccess: 'fldiArCcZx8uGtGl8', complaintsRole: 'fldP8Ugq5oLW0i8w5', active: 'fldcHPqfxScpuUbZ6', email: 'fldBggHLMX7abWiSK' };
const WORK_ROLES = ['Admin', 'Manager', 'Patroller/Supervisor'];

// Assignment email (Resend). If RESEND_API_KEY is unset the app still works —
// assignment just won't notify. ASSIGN_FROM must be a Resend-verified sender.
const RESEND_KEY  = process.env.RESEND_API_KEY;
const ASSIGN_FROM = process.env.ASSIGN_FROM || 'MRDC Complaints <noreply@mrdc-htra.com>';
const APP_URL     = process.env.COMPLAINTS_APP_URL || 'https://www.mrdc-htra.com/complaints/';

// Field IDs (stable even if a field is renamed; also dodges the trailing space in "Phone ").
const F = {
  name:        'fld2hB2OTdfKhNJJO', // formula primary (read-only)
  assignedTo:  'fldAsN8rlCHRumzFW', // singleSelect
  date:        'fldrjyRR3Q7BZcLtS', // date
  status:      'fldEo8P4pVdtdsTHA', // singleSelect
  receivedBy:  'fldJKSAspod1YuO6v', // singleSelect
  takenBy:     'fldUSVSjfWhLrNyd4', // Person Taking Report
  person:      'fldlGhp2DPw7ZcD2E', // Name of Person Contacting MRDC
  reason:      'fldH75Px7shL3Cv9n', // multipleSelects
  phone:       'fldW3L73XtoUtZTKF', // "Phone "
  email:       'fldPvo5JV7VdNHSOU',
  incidentDate:'flduSHOYcebtaAz8D',
  incidentTime:'fldtlloOVbwr6L00x',
  message:     'fldTLgeFGOVoJZcVe', // Message Taken
  action:      'fldJmruvDUTeKpwv7', // Action Taken
  attachments: 'fldEdt984rpo5Cild',
  callLog:     'fld017vusRZU7iEUZ',
};

// Sensible defaults; refreshed live from the Meta API when the PAT allows it.
const DEFAULT_CHOICES = {
  assignees: ['Jason Greeley', 'Mike Park', 'Derek Melanson', 'Roger Cormier', 'Bill Langley', 'Troy Johnston'],
  reasons:   ['Complaint', 'Compliment', 'Claim', 'Info', 'Other'],
  statuses:  ['Todo', 'In progress', 'Done', 'No Follow Up Required'],
  channels:  ['Website', 'Email', 'Phone', 'Verbal', 'Fax', 'Copy'],
};

async function airtable(path, options = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.error?.message || json.error?.type || `Airtable ${res.status}`); e.status = res.status; throw e; }
  return json;
}

const arr = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const sel = v => (v && typeof v === 'object' ? v.name : v) || '';

function shape(rec) {
  const f = rec.fields || {};
  const atts = arr(f[F.attachments]).map(a => ({ id: a.id, url: a.url, filename: a.filename, type: a.type, size: a.size, thumb: a.thumbnails?.small?.url || '' }));
  return {
    id: rec.id,
    label: f[F.name] || '',
    person: f[F.person] || '',
    email: f[F.email] || '',
    phone: f[F.phone] || '',
    date: f[F.date] || '',
    receivedBy: sel(f[F.receivedBy]),
    reason: arr(f[F.reason]).map(sel),
    status: sel(f[F.status]) || 'Todo',
    assignedTo: sel(f[F.assignedTo]),
    takenBy: f[F.takenBy] || '',
    message: f[F.message] || '',
    action: f[F.action] || '',
    incidentDate: f[F.incidentDate] || '',
    incidentTime: f[F.incidentTime] || '',
    attachments: atts,
    createdTime: rec.createdTime,
  };
}

// Build the Airtable fields object (by field id) from a friendly body.
function toFields(b) {
  const f = {};
  if (b.person       !== undefined) f[F.person]       = b.person;
  if (b.email        !== undefined) f[F.email]        = b.email;
  if (b.phone        !== undefined) f[F.phone]        = b.phone;
  if (b.date         !== undefined) f[F.date]         = b.date || null;
  if (b.receivedBy   !== undefined) f[F.receivedBy]   = b.receivedBy || null;
  if (b.reason       !== undefined) f[F.reason]       = arr(b.reason);
  if (b.status       !== undefined) f[F.status]       = b.status || null;
  if (b.assignedTo   !== undefined) f[F.assignedTo]   = b.assignedTo || null;
  if (b.takenBy      !== undefined) f[F.takenBy]      = b.takenBy;
  if (b.message      !== undefined) f[F.message]      = b.message;
  if (b.action       !== undefined) f[F.action]       = b.action;
  if (b.incidentDate !== undefined) f[F.incidentDate] = b.incidentDate || null;
  if (b.incidentTime !== undefined) f[F.incidentTime] = b.incidentTime;
  return f;
}

// Live assignee list from the Employees directory = anyone who can work Complaints.
// Returns sorted, de-duped names, or null on failure (caller falls back to defaults).
async function getAssignees() {
  try {
    const names = new Set();
    let offset;
    do {
      const qs = new URLSearchParams();
      qs.set('pageSize', '100');
      qs.set('returnFieldsByFieldId', 'true');
      ['name', 'role', 'appAccess', 'complaintsRole', 'active'].forEach(k => qs.append('fields[]', EF[k]));
      if (offset) qs.set('offset', offset);
      const page = await airtable(`${EMP_BASE}/${encodeURIComponent(EMP_TABLE)}?${qs}`);
      for (const rec of (page.records || [])) {
        const f = rec.fields || {};
        const name = f[EF.name];
        if (!name) continue;
        if (sel(f[EF.active]) === 'Inactive') continue;               // active only
        const worksComplaints =
          sel(f[EF.role]) === 'Owner' ||                              // owners work every app
          (arr(f[EF.appAccess]).map(sel).includes('Complaints') &&    // has access AND
           WORK_ROLES.includes(sel(f[EF.complaintsRole])));           // a write-level Complaints role
        if (worksComplaints) names.add(name);
      }
      offset = page.offset;
    } while (offset);
    return [...names].sort((a, b) => a.localeCompare(b));
  } catch (_) { return null; }
}

async function getChoices() {
  // reasons / statuses / received-by come from the table schema (Meta API); assignees
  // come LIVE from the Employees directory. Each falls back to DEFAULT_CHOICES.
  let reasons = DEFAULT_CHOICES.reasons, statuses = DEFAULT_CHOICES.statuses, channels = DEFAULT_CHOICES.channels;
  try {
    const j = await airtable(`meta/bases/${BASE}/tables`);
    const t = (j.tables || []).find(x => x.id === TABLE);
    if (t) {
      const byId = {}; (t.fields || []).forEach(fl => { byId[fl.id] = fl; });
      const opts = id => (byId[id]?.options?.choices || []).map(c => c.name);
      const r = opts(F.reason), s = opts(F.status), c = opts(F.receivedBy);
      if (r.length) reasons = r;
      if (s.length) statuses = s;
      if (c.length) channels = c;
    }
  } catch (_) { /* keep defaults */ }
  const assignees = (await getAssignees()) || DEFAULT_CHOICES.assignees;
  return { assignees, reasons, statuses, channels };
}

async function fetchAll() {
  const rows = [];
  let offset;
  do {
    const qs = new URLSearchParams();
    qs.set('pageSize', '100');
    qs.set('returnFieldsByFieldId', 'true');
    qs.set('sort[0][field]', F.date);
    qs.set('sort[0][direction]', 'desc');
    if (offset) qs.set('offset', offset);
    const page = await airtable(`${BASE}/${encodeURIComponent(TABLE)}?${qs}`);
    rows.push(...(page.records || []));
    offset = page.offset;
  } while (offset);
  return rows;
}

function corsOrigin(req) {
  const o = req.headers.origin || '';
  if (/^https:\/\/([a-z0-9-]+\.)*mrdc-htra\.com$/i.test(o)) return o;
  return 'https://www.mrdc-htra.com';
}
// Write access = "work records" (log / assign / status / action / attachments).
// Complaints app roles (from the person's Complaints Role, delivered as x-app-role;
// Owner resolves to Admin in auth):
//   Admin, Manager, Patroller/Supervisor  → can work records (write)
//   User  (or access with no role set)     → read-only (GET only; no write)
// GET is intentionally ungated so read-only users can view.
const WRITE_ROLES = ['Admin', 'Manager', 'Patroller/Supervisor'];
const canWrite = req =>
  WRITE_ROLES.includes(String(req.headers['x-app-role'] || '')) ||
  String(req.headers['x-user-role'] || '') === 'Owner';

// Look up an employee's email by their (assignee) name in the Employees directory.
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

const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Email a manager when a complaint is (newly) assigned to them. Best-effort:
// returns true if sent, false if skipped/failed — never throws to the caller.
async function sendAssignmentEmail(row, assigneeName, assignerName) {
  try {
    if (!RESEND_KEY || !assigneeName) return false;
    const to = await lookupEmployeeEmail(assigneeName);
    if (!to) return false;
    const link = APP_URL + (APP_URL.indexOf('?') >= 0 ? '&' : '?') + 'id=' + encodeURIComponent(row.id);
    const type = (row.reason || []).join(', ') || '—';
    const who = (row.person || '').trim() || '(no name given)';
    const msg = (row.message || '').trim();
    const excerpt = msg.length > 600 ? msg.slice(0, 600) + '…' : (msg || '—');
    const by = String(assignerName || '').trim();
    const subject = `Complaint assigned to you — ${who}`;
    const html =
      `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1a1a1a;max-width:560px">` +
      `<div style="background:#1E2B5E;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;border-bottom:3px solid #C9A84C">` +
      `<div style="font-size:17px;font-weight:600">A complaint has been assigned to you</div></div>` +
      `<div style="border:1px solid #DDD9D0;border-top:none;border-radius:0 0 10px 10px;padding:16px 18px">` +
      `<p style="margin:0 0 12px">Hi ${esc(assigneeName)},${by ? ` ${esc(by)} has assigned` : ' You have been assigned'} a complaint in the MRDC Complaints app.</p>` +
      `<table style="border-collapse:collapse;font-size:14px;margin:0 0 14px">` +
      `<tr><td style="color:#6B6B6B;padding:3px 12px 3px 0">From</td><td><b>${esc(who)}</b></td></tr>` +
      `<tr><td style="color:#6B6B6B;padding:3px 12px 3px 0">Type</td><td>${esc(type)}</td></tr>` +
      `<tr><td style="color:#6B6B6B;padding:3px 12px 3px 0">Received</td><td>${esc(row.date || '—')}${row.receivedBy ? ' · ' + esc(row.receivedBy) : ''}</td></tr>` +
      `<tr><td style="color:#6B6B6B;padding:3px 12px 3px 0">Status</td><td>${esc(row.status || 'Todo')}</td></tr>` +
      `</table>` +
      `<div style="color:#6B6B6B;font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px">Message</div>` +
      `<div style="background:#F7F7F5;border:1px solid #DDD9D0;border-radius:8px;padding:10px 12px;font-size:14px;white-space:pre-wrap;margin:0 0 16px">${esc(excerpt)}</div>` +
      `<a href="${esc(link)}" style="display:inline-block;background:#1E2B5E;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px">Open the complaint &rarr;</a>` +
      `</div></div>`;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ASSIGN_FROM, to: [to], subject, html }),
    });
    return r.ok;
  } catch (_) { return false; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', corsOrigin(req));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-role, x-app-role, x-user-name, x-user-id');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!PAT) return res.status(500).json({ error: 'Server not configured (AIRTABLE_PAT missing)' });

  try {
    if (req.method === 'GET') {
      if (String(req.query?.meta || '') === '1') return res.status(200).json({ choices: await getChoices() });
      const id = req.query?.id;
      if (id) {
        const rec = await airtable(`${BASE}/${encodeURIComponent(TABLE)}/${encodeURIComponent(id)}?returnFieldsByFieldId=true`);
        return res.status(200).json({ row: shape(rec) });
      }
      const recs = await fetchAll();
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ rows: recs.map(shape) });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // Attachment upload (POST { action:'upload', ... }) — content API.
    if (req.method === 'POST' && body.action === 'upload') {
      if (!canWrite(req)) return res.status(403).json({ error: 'You have view-only access to Complaints.' });
      const { id, filename, contentType, data } = body;
      if (!id || !data) return res.status(400).json({ error: 'id and data (base64) required' });
      const up = await fetch(`https://content.airtable.com/v0/${BASE}/${encodeURIComponent(id)}/${F.attachments}/uploadAttachment`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: contentType || 'application/octet-stream', file: data, filename: filename || 'attachment' }),
      });
      const j = await up.json().catch(() => ({}));
      if (!up.ok) return res.status(up.status).json({ error: j.error?.message || 'Upload failed' });
      // Return the freshly-updated record so the UI can re-render attachments.
      const rec = await airtable(`${BASE}/${encodeURIComponent(TABLE)}/${encodeURIComponent(id)}?returnFieldsByFieldId=true`);
      return res.status(200).json({ ok: true, row: shape(rec) });
    }

    if (req.method === 'POST') {
      if (!canWrite(req)) return res.status(403).json({ error: 'You have view-only access to Complaints.' });
      const fields = toFields(body);
      if (!body.status) fields[F.status] = 'Todo';
      if (!body.date)   fields[F.date]   = todayAtlantic();
      const created = await airtable(`${BASE}/${encodeURIComponent(TABLE)}`, {
        method: 'POST',
        body: JSON.stringify({ records: [{ fields }], typecast: true, returnFieldsByFieldId: true }),
      });
      const row = shape(created.records?.[0] || { id: '', fields: {} });
      let notified = false;
      if (body.assignedTo) notified = await sendAssignmentEmail(row, body.assignedTo, req.headers['x-user-name']);
      return res.status(200).json({ row, notified });
    }

    if (req.method === 'PATCH') {
      if (!canWrite(req)) return res.status(403).json({ error: 'You have view-only access to Complaints.' });
      if (!body.id) return res.status(400).json({ error: 'id required' });
      const fields = toFields(body);
      // Only notify when the assignee actually CHANGES to a new person (not on a
      // status/action edit, and not if they were already assigned to them).
      let prevAssigned = '';
      if (body.assignedTo) {
        try {
          const cur = await airtable(`${BASE}/${encodeURIComponent(TABLE)}/${encodeURIComponent(body.id)}?returnFieldsByFieldId=true`);
          prevAssigned = sel(cur.fields?.[F.assignedTo]);
        } catch (_) { /* ignore — worst case we send one extra email */ }
      }
      const updated = await airtable(`${BASE}/${encodeURIComponent(TABLE)}`, {
        method: 'PATCH',
        body: JSON.stringify({ records: [{ id: body.id, fields }], typecast: true, returnFieldsByFieldId: true }),
      });
      const row = shape(updated.records?.[0] || { id: body.id, fields: {} });
      let notified = false;
      if (body.assignedTo && body.assignedTo !== prevAssigned) {
        notified = await sendAssignmentEmail(row, body.assignedTo, req.headers['x-user-name']);
      }
      return res.status(200).json({ row, notified });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[complaints]', e.message);
    return res.status(e.status || 500).json({ error: e.message || 'Server error' });
  }
};
