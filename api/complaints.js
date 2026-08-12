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
// Env: AIRTABLE_PAT (read+write to the base), AIRTABLE_BASE (default below),
//      COMPLAINTS_TABLE (default table id below).

const PAT   = process.env.AIRTABLE_PAT;
const BASE  = process.env.AIRTABLE_BASE || 'app6PnSWS8BMnGbPe';
const TABLE = process.env.COMPLAINTS_TABLE || 'tblDuAOQ7ay26FmIa';

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

async function getChoices() {
  // Try the Meta API (needs schema.bases:read); fall back to defaults.
  try {
    const j = await airtable(`meta/bases/${BASE}/tables`);
    const t = (j.tables || []).find(x => x.id === TABLE);
    if (t) {
      const byId = {}; (t.fields || []).forEach(fl => { byId[fl.id] = fl; });
      const opts = id => (byId[id]?.options?.choices || []).map(c => c.name);
      const a = opts(F.assignedTo), r = opts(F.reason), s = opts(F.status), c = opts(F.receivedBy);
      return {
        assignees: a.length ? a : DEFAULT_CHOICES.assignees,
        reasons:   r.length ? r : DEFAULT_CHOICES.reasons,
        statuses:  s.length ? s : DEFAULT_CHOICES.statuses,
        channels:  c.length ? c : DEFAULT_CHOICES.channels,
      };
    }
  } catch (_) { /* fall through */ }
  return DEFAULT_CHOICES;
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
      if (!body.date)   fields[F.date]   = new Date().toISOString().slice(0, 10);
      const created = await airtable(`${BASE}/${encodeURIComponent(TABLE)}`, {
        method: 'POST',
        body: JSON.stringify({ records: [{ fields }], typecast: true, returnFieldsByFieldId: true }),
      });
      return res.status(200).json({ row: shape(created.records?.[0] || { id: '', fields: {} }) });
    }

    if (req.method === 'PATCH') {
      if (!canWrite(req)) return res.status(403).json({ error: 'You have view-only access to Complaints.' });
      if (!body.id) return res.status(400).json({ error: 'id required' });
      const fields = toFields(body);
      const updated = await airtable(`${BASE}/${encodeURIComponent(TABLE)}`, {
        method: 'PATCH',
        body: JSON.stringify({ records: [{ id: body.id, fields }], typecast: true, returnFieldsByFieldId: true }),
      });
      return res.status(200).json({ row: shape(updated.records?.[0] || { id: body.id, fields: {} }) });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[complaints]', e.message);
    return res.status(e.status || 500).json({ error: e.message || 'Server error' });
  }
};
