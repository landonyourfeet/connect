require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ── JIREH SECURITY — SSE client registry ─────────────────────────────────
const sseClients = new Set();
function broadcastSecurityEvent(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  let dead = [];
  for (const client of sseClients) {
    try { client.res.write(data); }
    catch(e) { dead.push(client); }
  }
  dead.forEach(c => sseClients.delete(c));
  console.log(`[Jireh] Broadcast to ${sseClients.size} client(s):`, payload.eventId || payload.type);
}

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));
// Serve Twilio Voice SDK from node_modules
app.get('/twilio-voice.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/@twilio/voice-sdk/dist/twilio.min.js'));
});

// ── FAVICON — serve PNG + ICO directly (Chrome ignores SVG-only setups) ──
const _pngBuf = Buffer.from('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', 'base64');
const _icoBuf = Buffer.from('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', 'base64');

app.get('/favicon.png', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(_pngBuf);
});
app.get('/favicon.ico', (req, res) => {
  res.setHeader('Content-Type', 'image/x-icon');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(_icoBuf);
});
app.get('/favicon.svg', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="10" fill="#0a0a0f"/>
    <text x="32" y="44" font-family="Arial Black,sans-serif" font-size="38" font-weight="900"
      text-anchor="middle" fill="#e6e6e6">OK<tspan fill="#e63946">C</tspan></text>
  </svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

const auth = async (req, res, next) => {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(h.slice(7), JWT_SECRET);
    const r = await pool.query('SELECT * FROM agents WHERE id=$1 AND is_active=true', [decoded.id]);
    if (!r.rows[0]) return res.status(401).json({ error: 'Unauthorized' });
    req.agent = r.rows[0];
    next();
  } catch (e) { res.status(401).json({ error: 'Unauthorized' }); }
};

const adminOnly = (req, res, next) => {
  if (req.agent?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
};

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV }));

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const r = await pool.query('SELECT * FROM agents WHERE email=$1 AND is_active=true', [email]);
    if (!r.rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: r.rows[0].id }, JWT_SECRET, { expiresIn: '7d' });
    const { password_hash, ...agent } = r.rows[0];
    res.json({ token, agent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, (req, res) => {
  const { password_hash, ...agent } = req.agent;
  res.json(agent);
});

// ─── PEOPLE ───────────────────────────────────────────────────────────────────
app.get('/api/people', auth, async (req, res) => {
  try {
    const { search, stage, tags, smartListId, limit = 50, offset = 0 } = req.query;
    let where = ['1=1']; let params = [];
    if (search) {
      const parts = search.trim().split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        // Full name search — match first+last in either order
        params.push(`%${parts[0]}%`); const p1 = params.length;
        params.push(`%${parts.slice(1).join(' ')}%`); const p2 = params.length;
        params.push(`%${parts[parts.length-1]}%`); const p3 = params.length;
        params.push(`%${parts.slice(0,-1).join(' ')}%`); const p4 = params.length;
        params.push(`%${search}%`); const pFull = params.length;
        where.push(`(
          (p.first_name ILIKE $${p1} AND p.last_name ILIKE $${p2}) OR
          (p.first_name ILIKE $${p3} AND p.last_name ILIKE $${p4}) OR
          p.phone ILIKE $${pFull} OR p.email ILIKE $${pFull} OR
          EXISTS(SELECT 1 FROM person_phones pp2 WHERE pp2.person_id=p.id AND pp2.phone ILIKE $${pFull})
        )`);
      } else {
        params.push(`%${search}%`);
        const pi = params.length;
        where.push(`(
          p.first_name ILIKE $${pi} OR p.last_name ILIKE $${pi} OR
          p.phone ILIKE $${pi} OR p.email ILIKE $${pi} OR
          EXISTS(SELECT 1 FROM person_phones pp2 WHERE pp2.person_id=p.id AND pp2.phone ILIKE $${pi})
        )`);
      }
    }
    if (stage) { params.push(stage); where.push(`p.stage=$${params.length}`); }
    if (tags) {
      // tags=Delinquent,Eviction — must have ALL specified tags
      const tagList = tags.split(',').map(t=>t.trim()).filter(Boolean);
      for (const tag of tagList) { params.push(tag); where.push(`$${params.length}=ANY(p.tags)`); }
    }
    // Smart list — load filters from DB and apply
    if (smartListId) {
      const listR = await pool.query('SELECT filters FROM smart_lists WHERE id=$1', [smartListId]);
      if (listR.rows[0]?.filters) {
        const f = listR.rows[0].filters;
        if (f.stage)  { params.push(f.stage); where.push(`p.stage=$${params.length}`); }
        if (f.tags?.length) {
          for (const tag of f.tags) { params.push(tag); where.push(`$${params.length}=ANY(p.tags)`); }
        }
        if (f.source) { params.push(f.source); where.push(`p.source=$${params.length}`); }
        if (f.has_phone) where.push(`p.phone IS NOT NULL AND p.phone!=''`);
        if (f.no_activity_days) {
          params.push(parseInt(f.no_activity_days));
          where.push(`(SELECT MAX(created_at) FROM activities WHERE person_id=p.id) < NOW()-INTERVAL '1 day'*$${params.length} OR NOT EXISTS (SELECT 1 FROM activities WHERE person_id=p.id)`);
        }
      }
    }
    const countR = await pool.query(`SELECT COUNT(*) FROM people p WHERE ${where.join(' AND ')}`, params);
    params.push(limit, offset);
    const r = await pool.query(
      `SELECT p.* FROM people p WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    // Attach all phone numbers per person so frontend can match inbound calls correctly
    if (r.rows.length) {
      const ids = r.rows.map(p => p.id);
      const phones = await pool.query(
        `SELECT person_id, phone FROM person_phones WHERE person_id = ANY($1) AND (is_bad IS NULL OR is_bad=false)`,
        [ids]
      );
      const phoneMap = {};
      phones.rows.forEach(row => {
        if (!phoneMap[row.person_id]) phoneMap[row.person_id] = [];
        phoneMap[row.person_id].push(row.phone);
      });
      r.rows.forEach(p => { p.all_phones = phoneMap[p.id] || (p.phone ? [p.phone] : []); });
    }
    res.json({ people: r.rows, total: parseInt(countR.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/people/:id', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, first_name, last_name, phone, email, stage, source, background, tags,
             custom_fields, address, city, state, zip, assigned_to, unifi_person_id,
             id_photo_b64, id_photo_name, security_notes, criminal_history,
             dv_victim, dv_notes, created_at, updated_at
      FROM people WHERE id=$1
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/people', auth, async (req, res) => {
  try {
    const { firstName, lastName, phone, email, stage, source, background, tags, customFields, assignedTo, address, city, state, zip } = req.body;

    // ── Duplicate check ──────────────────────────────────────────────────────
    const normPhone = phone ? (() => { const d = phone.replace(/\D/g,''); return d.length===10?'+1'+d:d.length===11&&d[0]==='1'?'+'+d:null; })() : null;
    const dupeChecks = [];
    if (normPhone) dupeChecks.push(
      pool.query(`SELECT p.id,p.first_name,p.last_name,p.phone,p.email,p.stage FROM people p
        LEFT JOIN person_phones pp ON pp.person_id=p.id
        WHERE p.phone=$1 OR pp.phone=$1 LIMIT 1`, [normPhone])
    );
    if (email) dupeChecks.push(
      pool.query(`SELECT id,first_name,last_name,phone,email,stage FROM people WHERE LOWER(email)=LOWER($1) LIMIT 1`, [email])
    );
    for (const chk of await Promise.all(dupeChecks)) {
      if (chk.rows[0]) {
        const ex = chk.rows[0];
        return res.status(409).json({
          error: 'duplicate',
          message: `A contact already exists with this ${normPhone && chk.rows[0] ? 'phone number' : 'email'}.`,
          existing: { id: ex.id, name: [ex.first_name, ex.last_name].filter(Boolean).join(' '), phone: ex.phone, email: ex.email, stage: ex.stage }
        });
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    const r = await pool.query(
      'INSERT INTO people (first_name,last_name,phone,email,stage,source,background,tags,custom_fields,assigned_to,address,city,state,zip) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',
      [firstName, lastName, phone||null, email||null, stage||'lead', source||null, background||null, tags||[], JSON.stringify(customFields||{}), assignedTo||null, address||null, city||null, state||null, zip||null]
    );
    // If phone provided, also seed into person_phones
    if (phone && r.rows[0]) {
      await pool.query(
        'INSERT INTO person_phones (person_id,phone,label,is_primary) VALUES($1,$2,$3,TRUE) ON CONFLICT DO NOTHING',
        [r.rows[0].id, phone.replace(/[^0-9+]/g,''), 'mobile']
      ).catch(()=>{});
    }
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CASEWORKER NOTIFICATION HELPER ────────────────────────────────────────────
async function notifyCaseworkers(residentId, triggerType, agentId) {
  try {
    // Find all caseworkers linked to this resident
    const rels = await pool.query(`
      SELECT
        CASE WHEN pr.person_id_a = $1 THEN pr.person_id_b ELSE pr.person_id_a END AS cw_id
      FROM person_relationships pr
      WHERE (pr.person_id_a = $1 OR pr.person_id_b = $1)
        AND pr.label = 'caseworker'
    `, [residentId]);

    if (!rels.rows.length) return;

    // Get resident info
    const res = await pool.query('SELECT first_name, last_name, stage FROM people WHERE id=$1', [residentId]);
    const resident = res.rows[0];
    if (!resident) return;
    const resName = [resident.first_name, resident.last_name].filter(Boolean).join(' ');

    const msgs = {
      delinquent:      `⚠️ OKCREAL Alert: ${resName} has been moved to Delinquent status. Your support may be needed.`,
      lease_violation: `⚠️ OKCREAL Alert: ${resName} has received a lease violation. Your support may be needed.`,
      evicting:        `⚠️ OKCREAL Alert: ${resName} has been moved to Eviction status. Your support may be needed.`,
    };
    const msg = msgs[triggerType] || `⚠️ OKCREAL Alert: Update on ${resName} — ${triggerType}.`;

    for (const row of rels.rows) {
      const cwId = row.cw_id;
      // Get caseworker phone
      const cwRes = await pool.query(`
        SELECT p.id, p.first_name, p.last_name, pp.phone
        FROM people p
        LEFT JOIN person_phones pp ON pp.person_id = p.id AND pp.is_primary = true
        WHERE p.id = $1
      `, [cwId]);
      const cw = cwRes.rows[0];
      if (!cw) continue;

      const cwName = [cw.first_name, cw.last_name].filter(Boolean).join(' ');

      // Log activity on RESIDENT record
      await pool.query(
        `INSERT INTO activities (person_id, agent_id, type, body, direction)
         VALUES ($1, $2, 'note', $3, 'internal')`,
        [residentId, agentId || null, `📋 Caseworker ${cwName} notified: ${triggerType.replace('_',' ')}`]
      );

      // Log activity on CASEWORKER record
      await pool.query(
        `INSERT INTO activities (person_id, agent_id, type, body, direction)
         VALUES ($1, $2, 'note', $3, 'internal')`,
        [cwId, agentId || null, `📋 Notified re: resident ${resName} — ${triggerType.replace('_',' ')}`]
      );

      // Send SMS if caseworker has a phone
      if (cw.phone) {
        try {
          const twilioClient = initTwilioFull();
          const fromNum = process.env.TWILIO_RESIDENT_NUMBER || '+14052562614';
          const sent = await twilioClient.messages.create({
            body: msg,
            from: fromNum,
            to: cw.phone.replace(/\D/g,'').replace(/^(\d{10})$/, '+1$1')
          });
          console.log(`[Caseworker] SMS sent to ${cwName} (${cw.phone}): ${sent.sid}`);
        } catch(smsErr) {
          console.warn(`[Caseworker] SMS failed for ${cwName}:`, smsErr.message);
        }
      }
    }
  } catch(e) {
    console.error('[notifyCaseworkers] Error:', e.message);
  }
}

app.put('/api/people/:id', auth, async (req, res) => {
  try {
    const { firstName, lastName, phone, email, stage, source, background, tags, customFields, assignedTo, address, city, state, zip } = req.body;
    const r = await pool.query(
      `UPDATE people SET
        first_name=COALESCE($1,first_name), last_name=COALESCE($2,last_name),
        phone=COALESCE($3,phone), email=COALESCE($4,email),
        stage=COALESCE($5,stage), source=COALESCE($6,source),
        background=COALESCE($7,background), tags=COALESCE($8,tags),
        custom_fields=custom_fields||COALESCE($9::jsonb,'{}'),
        address=COALESCE($10,address), city=COALESCE($11,city),
        state=COALESCE($12,state), zip=COALESCE($13,zip),
        updated_at=NOW()
       WHERE id=$14 RETURNING *`,
      [firstName||null, lastName||null, phone||null, email||null, stage||null,
       source||null, background||null, tags||null,
       customFields ? JSON.stringify(customFields) : null,
       address||null, city||null, state||null, zip||null, req.params.id]
    );
    const updated = r.rows[0];

    // Notify caseworkers on delinquent/evicting stage changes
    if (stage && (stage === 'Delinquent' || stage === 'Evicting')) {
      const agentId = req.user?.id || null;
      const triggerType = stage === 'Delinquent' ? 'delinquent' : 'evicting';
      notifyCaseworkers(req.params.id, triggerType, agentId).catch(e => console.warn('[CW trigger]', e.message));
    }

    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/people/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM people WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PERSON PHONES ────────────────────────────────────────────────────────────
app.get('/api/people/:id/phones', auth, async (req, res) => {
  try {
    // Also migrate people.phone into person_phones if not there yet
    const existing = await pool.query('SELECT COUNT(*) FROM person_phones WHERE person_id=$1', [req.params.id]);
    if (parseInt(existing.rows[0].count) === 0) {
      const p = await pool.query('SELECT phone FROM people WHERE id=$1', [req.params.id]);
      if (p.rows[0]?.phone) {
        await pool.query('INSERT INTO person_phones (person_id,phone,label,is_primary) VALUES($1,$2,$3,TRUE) ON CONFLICT DO NOTHING',
          [req.params.id, p.rows[0].phone, 'mobile']).catch(()=>{});
      }
    }
    const r = await pool.query('SELECT * FROM person_phones WHERE person_id=$1 ORDER BY is_primary DESC, id ASC', [req.params.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/people/:id/phones', auth, async (req, res) => {
  try {
    const { phone, label, isPrimary } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    const clean = phone.replace(/[^0-9+]/g,'');
    if (isPrimary) await pool.query('UPDATE person_phones SET is_primary=FALSE WHERE person_id=$1', [req.params.id]);
    const r = await pool.query(
      'INSERT INTO person_phones (person_id,phone,label,is_primary) VALUES($1,$2,$3,$4) RETURNING *',
      [req.params.id, clean, label||'mobile', !!isPrimary]
    );
    if (isPrimary) await pool.query('UPDATE people SET phone=$1 WHERE id=$2', [clean, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/people/:id/phones/:phoneId', auth, async (req, res) => {
  try {
    const { label, isPrimary, isBad } = req.body;
    if (isPrimary) await pool.query('UPDATE person_phones SET is_primary=FALSE WHERE person_id=$1', [req.params.id]);
    const r = await pool.query(
      `UPDATE person_phones SET
         label=COALESCE($1,label), is_primary=COALESCE($2,is_primary), is_bad=COALESCE($3,is_bad)
       WHERE id=$4 AND person_id=$5 RETURNING *`,
      [label||null, isPrimary!=null?isPrimary:null, isBad!=null?isBad:null, req.params.phoneId, req.params.id]
    );
    if (isPrimary && r.rows[0]) await pool.query('UPDATE people SET phone=$1 WHERE id=$2', [r.rows[0].phone, req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/people/:id/phones/:phoneId', auth, async (req, res) => {
  try {
    const del = await pool.query('DELETE FROM person_phones WHERE id=$1 AND person_id=$2 RETURNING *', [req.params.phoneId, req.params.id]);
    // If we deleted the primary, promote the next one
    if (del.rows[0]?.is_primary) {
      const next = await pool.query('SELECT * FROM person_phones WHERE person_id=$1 ORDER BY id ASC LIMIT 1', [req.params.id]);
      if (next.rows[0]) {
        await pool.query('UPDATE person_phones SET is_primary=TRUE WHERE id=$1', [next.rows[0].id]);
        await pool.query('UPDATE people SET phone=$1 WHERE id=$2', [next.rows[0].phone, req.params.id]);
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── HOUSEHOLD / RELATIONSHIPS ────────────────────────────────────────────────
app.get('/api/people/:id/relationships', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT pr.id, pr.label,
        CASE WHEN pr.person_id_a=$1 THEN pr.person_id_b ELSE pr.person_id_a END AS related_id,
        p.first_name, p.last_name, p.phone, p.stage, p.email
      FROM person_relationships pr
      JOIN people p ON p.id = CASE WHEN pr.person_id_a=$1 THEN pr.person_id_b ELSE pr.person_id_a END
      WHERE pr.person_id_a=$1 OR pr.person_id_b=$1
    `, [req.params.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/people/:id/relationships', auth, async (req, res) => {
  try {
    const { relatedPersonId, label } = req.body;
    if (!relatedPersonId) return res.status(400).json({ error: 'relatedPersonId required' });
    const a = Math.min(parseInt(req.params.id), parseInt(relatedPersonId));
    const b = Math.max(parseInt(req.params.id), parseInt(relatedPersonId));
    const r = await pool.query(
      'INSERT INTO person_relationships (person_id_a,person_id_b,label) VALUES($1,$2,$3) ON CONFLICT(person_id_a,person_id_b) DO UPDATE SET label=$3 RETURNING *',
      [a, b, label||'household']
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/people/:id/relationships/:relId', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM person_relationships WHERE id=$1', [req.params.relId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Household combined timeline — all activities for a person + their household members
// ── SECURITY PROFILE ─────────────────────────────────────────────────────

// Upload / replace ID photo (accepts base64 JSON)
app.post('/api/people/:id/id-photo', auth, async (req, res) => {
  try {
    let { photoB64, photoName } = req.body;
    if (!photoB64) return res.status(400).json({ error: 'photoB64 required' });

    // Strip data URL prefix if present — store only the raw base64
    if (photoB64.startsWith('data:')) {
      photoB64 = photoB64.split(',')[1];
    }

    // ~7MB raw base64 max (covers ~5MB image files)
    if (photoB64.length > 7000000) return res.status(413).json({ error: 'Image too large (max ~5MB)' });

    await pool.query(
      'UPDATE people SET id_photo_b64=$1, id_photo_name=$2, updated_at=NOW() WHERE id=$3',
      [photoB64, photoName || 'id-photo', req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete ID photo
app.delete('/api/people/:id/id-photo', auth, async (req, res) => {
  try {
    await pool.query('UPDATE people SET id_photo_b64=NULL, id_photo_name=NULL, updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Save security profile (notes, criminal history, DV)
app.patch('/api/people/:id/security', auth, async (req, res) => {
  try {
    const { securityNotes, criminalHistory, dvVictim, dvNotes } = req.body;
    await pool.query(
      `UPDATE people SET
        security_notes = COALESCE($1, security_notes),
        criminal_history = COALESCE($2, criminal_history),
        dv_victim = COALESCE($3, dv_victim),
        dv_notes = COALESCE($4, dv_notes),
        updated_at = NOW()
       WHERE id=$5`,
      [
        securityNotes !== undefined ? securityNotes : null,
        criminalHistory !== undefined ? criminalHistory : null,
        dvVictim !== undefined ? dvVictim : null,
        dvNotes !== undefined ? dvNotes : null,
        req.params.id
      ]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST a lease violation — notifies caseworkers automatically
app.post('/api/people/:id/lease-violation', auth, async (req, res) => {
  try {
    const { note } = req.body;
    const agentId = req.user?.id || null;
    const body = note ? `🚨 Lease Violation: ${note}` : '🚨 Lease Violation logged';
    const act = await pool.query(
      `INSERT INTO activities (person_id, agent_id, type, body, direction)
       VALUES ($1, $2, 'note', $3, 'internal') RETURNING *`,
      [req.params.id, agentId, body]
    );
    // Notify caseworkers
    await notifyCaseworkers(req.params.id, 'lease_violation', agentId);
    res.json(act.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET caseworkers for a resident (or residents for a caseworker)
app.get('/api/people/:id/caseworkers', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        p.id, p.first_name, p.last_name, p.email, p.stage,
        pp.phone,
        CASE WHEN pr.person_id_a = $1 THEN 'b' ELSE 'a' END AS role_side,
        pr.id AS rel_id
      FROM person_relationships pr
      JOIN people p ON p.id = CASE WHEN pr.person_id_a = $1 THEN pr.person_id_b ELSE pr.person_id_a END
      LEFT JOIN person_phones pp ON pp.person_id = p.id AND pp.is_primary = true
      WHERE (pr.person_id_a = $1 OR pr.person_id_b = $1)
        AND pr.label = 'caseworker'
    `, [req.params.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/people/:id/household-activities', auth, async (req, res) => {
  try {
    const memberIds = [parseInt(req.params.id)];
    const rels = await pool.query(`
      SELECT CASE WHEN person_id_a=$1 THEN person_id_b ELSE person_id_a END AS related_id
      FROM person_relationships WHERE person_id_a=$1 OR person_id_b=$1
    `, [req.params.id]);
    rels.rows.forEach(r => memberIds.push(parseInt(r.related_id)));
    const placeholders = memberIds.map((_,i) => `$${i+1}`).join(',');
    const r = await pool.query(`
      SELECT a.*, p.first_name, p.last_name
      FROM activities a
      JOIN people p ON p.id = a.person_id
      WHERE a.person_id IN (${placeholders})
      ORDER BY a.created_at DESC LIMIT 100
    `, memberIds);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── ACTIVITIES ───────────────────────────────────────────────────────────────
// ── INBOX ─────────────────────────────────────────────────────────────────────
app.get('/api/inbox', auth, async (req, res) => {
  try {
    const missedR = await pool.query(`
      SELECT
        c.id, c.from_number AS phone, c.created_at,
        c.status, c.direction,
        p.id AS person_id,
        COALESCE(p.first_name || ' ' || COALESCE(p.last_name,''), c.from_number) AS contact_name
      FROM calls c
      LEFT JOIN people p ON p.id::text = c.person_id
      WHERE c.direction = 'inbound'
        AND c.status IN ('no-answer','busy','failed','canceled')
        AND c.created_at > NOW() - INTERVAL '7 days'
        AND (c.inbox_cleared IS NULL OR c.inbox_cleared = false)
      ORDER BY c.created_at DESC
      LIMIT 50
    `);

    const textsR = await pool.query(`
      SELECT
        a.id, a.body, a.created_at, a.person_id,
        COALESCE(pp.phone, p.phone) AS phone,
        COALESCE(p.first_name || ' ' || COALESCE(p.last_name,''), p.phone) AS contact_name
      FROM activities a
      LEFT JOIN people p ON p.id::text = a.person_id
      LEFT JOIN person_phones pp ON pp.person_id = p.id AND pp.is_primary = true
      WHERE a.type = 'sms'
        AND a.direction = 'inbound'
        AND a.created_at > NOW() - INTERVAL '7 days'
        AND (a.inbox_cleared IS NULL OR a.inbox_cleared = false)
      ORDER BY a.created_at DESC
      LIMIT 50
    `);

    res.json({ missed_calls: missedR.rows, unread_texts: textsR.rows });
  } catch(e) { console.error('Inbox error:', e.message); res.status(500).json({ error: e.message }); }
});

// Clear inbox notifications
app.post('/api/inbox/clear', auth, async (req, res) => {
  try {
    const { type } = req.body; // 'missed', 'texts', or 'all'
    if (type === 'missed' || type === 'all') {
      await pool.query(`UPDATE calls SET inbox_cleared=true WHERE direction='inbound' AND status IN ('no-answer','busy','failed','canceled') AND created_at > NOW() - INTERVAL '7 days'`);
    }
    if (type === 'texts' || type === 'all') {
      await pool.query(`UPDATE activities SET inbox_cleared=true WHERE type='sms' AND direction='inbound' AND created_at > NOW() - INTERVAL '7 days'`);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clear security event notifications
app.post('/api/security/events/clear', auth, async (req, res) => {
  try {
    await pool.query(`UPDATE security_events SET dismissed=true WHERE dismissed=false`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/activities', auth, async (req, res) => {
  try {
    const { personId, limit = 50, type } = req.query;
    let where = ['1=1']; let params = [];
    if (personId) { params.push(personId); where.push(`a.person_id=$${params.length}`); }
    if (type) { params.push(type); where.push(`a.type=$${params.length}`); }
    params.push(limit);
    const r = await pool.query(
      `SELECT
         a.id, a.person_id, a.agent_id, a.call_id, a.type, a.body,
         a.duration, a.direction, a.sms_status, a.sms_error, a.message_sid,
         a.created_at,
         ag.name AS agent_name,
         c.transcript,
         c.summary,
         COALESCE(a.recording_url, c.recording_url) AS recording_url
       FROM activities a
       LEFT JOIN agents ag ON ag.id::text = a.agent_id::text
       LEFT JOIN calls c ON c.id::text = a.call_id::text
       WHERE ${where.join(' AND ')}
       ORDER BY a.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/activities', auth, async (req, res) => {
  try {
    const { personId, type, body, duration, recordingUrl, callId, direction } = req.body;
    const r = await pool.query(
      'INSERT INTO activities (person_id,agent_id,type,body,duration,recording_url,call_id,direction) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [personId, req.agent.id, type||'note', body||null, duration||null, recordingUrl||null, callId||null, direction||'outbound']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TASKS ────────────────────────────────────────────────────────────────────
app.get('/api/tasks', auth, async (req, res) => {
  try {
    const { personId, completed } = req.query;
    let where = ['1=1']; let params = [];
    if (personId) { params.push(personId); where.push(`t.person_id=$${params.length}`); }
    if (completed !== undefined) { params.push(completed === 'true'); where.push(`t.completed=$${params.length}`); }
    const r = await pool.query(
      `SELECT t.*, ag.name as agent_name
       FROM tasks t
       LEFT JOIN agents ag ON ag.id::text=t.agent_id::text
       WHERE ${where.join(' AND ')} ORDER BY t.due_date ASC NULLS LAST`,
      params
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tasks', auth, async (req, res) => {
  try {
    const { personId, title, note, dueDate } = req.body;
    const r = await pool.query(
      'INSERT INTO tasks (person_id,agent_id,title,note,due_date) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [personId, req.agent.id, title, note||null, dueDate||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tasks/:id', auth, async (req, res) => {
  try {
    const { title, note, dueDate, completed } = req.body;
    const r = await pool.query(
      `UPDATE tasks SET
        title=COALESCE($1,title), note=COALESCE($2,note),
        due_date=COALESCE($3,due_date), completed=COALESCE($4,completed),
        completed_at=CASE WHEN $4=true THEN NOW() WHEN $4=false THEN NULL ELSE completed_at END
       WHERE id=$5 RETURNING *`,
      [title||null, note||null, dueDate||null, completed!=null?completed:null, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SMART LISTS & CUSTOM FIELDS ──────────────────────────────────────────────
app.get('/api/smart-lists', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM smart_lists ORDER BY sort_order');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/smart-lists', auth, async (req, res) => {
  try {
    const { name, filters = {} } = req.body;
    const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 as n FROM smart_lists');
    const r = await pool.query(
      'INSERT INTO smart_lists (name,filters,sort_order) VALUES($1,$2::jsonb,$3) RETURNING *',
      [name, JSON.stringify(filters), maxOrder.rows[0].n]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/smart-lists/:id', auth, async (req, res) => {
  try {
    const { name, filters } = req.body;
    const r = await pool.query(
      'UPDATE smart_lists SET name=COALESCE($1,name), filters=COALESCE($2::jsonb,filters) WHERE id=$3 RETURNING *',
      [name||null, filters ? JSON.stringify(filters) : null, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/smart-lists/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM smart_lists WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/custom-fields', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM custom_fields ORDER BY sort_order');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TWILIO HELPERS ───────────────────────────────────────────────────────────
const initTwilio = () => {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_API_KEY_SID) return null;
  return require('twilio')(process.env.TWILIO_API_KEY_SID, process.env.TWILIO_API_KEY_SECRET, {
    accountSid: process.env.TWILIO_ACCOUNT_SID
  });
};

const initTwilioFull = () => {
  // Prefer API Key credentials (what's actually set in Railway)
  // Falls back to AUTH_TOKEN if set
  const sid = process.env.TWILIO_ACCOUNT_SID;
  if (!sid) return null;
  if (process.env.TWILIO_API_KEY_SID && process.env.TWILIO_API_KEY_SECRET) {
    return require('twilio')(process.env.TWILIO_API_KEY_SID, process.env.TWILIO_API_KEY_SECRET, { accountSid: sid });
  }
  if (process.env.TWILIO_AUTH_TOKEN) {
    return require('twilio')(sid, process.env.TWILIO_AUTH_TOKEN);
  }
  return null;
};

// Helper: Basic Auth buffer for downloading Twilio recordings
// Uses API Key SID + Secret (preferred) or Account SID + Auth Token
const twilioBasicAuth = () => {
  if (process.env.TWILIO_API_KEY_SID && process.env.TWILIO_API_KEY_SECRET) {
    return Buffer.from(`${process.env.TWILIO_API_KEY_SID}:${process.env.TWILIO_API_KEY_SECRET}`).toString('base64');
  }
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    return Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  }
  return null;
};

const initDeepgram = () => {
  if (!process.env.DEEPGRAM_API_KEY) return null;
  const { createClient } = require('@deepgram/sdk');
  return createClient(process.env.DEEPGRAM_API_KEY);
};

const initGrok = () => {
  if (!process.env.GROK_API_KEY) return null;
  const OpenAI = require('openai');
  return new OpenAI({ apiKey: process.env.GROK_API_KEY, baseURL: 'https://api.x.ai/v1' });
};

// ─── TWILIO TOKEN (GET + POST) ────────────────────────────────────────────────
const buildTwilioToken = async (req, res) => {
  try {
    const twilio = initTwilio();
    if (!twilio) return res.status(503).json({ error: 'Twilio not configured' });
    const { AccessToken } = require('twilio').jwt;
    const { VoiceGrant } = AccessToken;
    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY_SID,
      process.env.TWILIO_API_KEY_SECRET,
      { identity: req.agent.id, ttl: 3600 }
    );
    token.addGrant(new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
      incomingAllow: true
    }));
    res.json({ token: token.toJwt(), identity: req.agent.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
};

app.get('/api/twilio/token', auth, buildTwilioToken);
app.post('/api/twilio/token', auth, buildTwilioToken);

app.get('/api/twilio/lines', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM call_lines WHERE is_active=true ORDER BY name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SMS SEND ─────────────────────────────────────────────────────────────────
app.post('/api/twilio/sms', auth, async (req, res) => {
  try {
    // Use full auth client for messaging (API key doesn't support messages.create in all configs)
    const twilio = initTwilioFull() || initTwilio();
    if (!twilio) return res.status(503).json({ error: 'Twilio not configured' });

    const { to, body, personId, lineId } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'Missing to or body' });

    // Resolve from number
    let fromNumber = process.env.TWILIO_RESIDENT_NUMBER || '+14052562614';
    if (lineId) {
      const lineR = await pool.query('SELECT twilio_number FROM call_lines WHERE id=$1', [lineId]);
      if (lineR.rows[0]) fromNumber = lineR.rows[0].twilio_number;
    }

    // Insert activity first with status 'sending' so we have the ID for status callback
    const actR = await pool.query(
      `INSERT INTO activities (person_id, agent_id, type, body, direction, sms_status)
       VALUES ($1, $2, 'text', $3, 'outbound', 'sending') RETURNING *`,
      [personId || null, req.agent.id, body]
    );
    const activityId = actR.rows[0].id;

    // Send via Twilio — include statusCallback so we get delivery receipts
    const statusCallbackUrl = process.env.APP_URL
      ? `${process.env.APP_URL}/api/twilio/sms-status?activityId=${activityId}`
      : null;

    try {
      const msgParams = { body, from: fromNumber, to };
      if (statusCallbackUrl) msgParams.statusCallback = statusCallbackUrl;

      const message = await twilio.messages.create(msgParams);

      // Update activity with Twilio SID and sent status
      await pool.query(
        `UPDATE activities SET message_sid=$1, sms_status='sent' WHERE id=$2`,
        [message.sid, activityId]
      );

      res.json({ ok: true, sid: message.sid, activityId });
    } catch (twilioErr) {
      // Mark as failed in DB
      await pool.query(
        `UPDATE activities SET sms_status='failed', sms_error=$1 WHERE id=$2`,
        [twilioErr.message, activityId]
      );
      res.status(500).json({ error: twilioErr.message, activityId });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SMS RETRY ────────────────────────────────────────────────────────────────
app.post('/api/twilio/sms/retry/:activityId', auth, async (req, res) => {
  try {
    const twilio = initTwilioFull() || initTwilio();
    if (!twilio) return res.status(503).json({ error: 'Twilio not configured' });

    const actR = await pool.query('SELECT * FROM activities WHERE id=$1', [req.params.activityId]);
    const act = actR.rows[0];
    if (!act) return res.status(404).json({ error: 'Activity not found' });

    const personR = act.person_id
      ? await pool.query('SELECT phone FROM people WHERE id=$1', [act.person_id])
      : null;
    const to = personR?.rows[0]?.phone;
    if (!to) return res.status(400).json({ error: 'No phone number on contact' });

    const fromNumber = process.env.TWILIO_RESIDENT_NUMBER || '+14052562614';

    // Reset status to sending
    await pool.query(`UPDATE activities SET sms_status='sending', sms_error=NULL WHERE id=$1`, [act.id]);

    const statusCallbackUrl = process.env.APP_URL
      ? `${process.env.APP_URL}/api/twilio/sms-status?activityId=${act.id}`
      : null;

    try {
      const msgParams = { body: act.body, from: fromNumber, to };
      if (statusCallbackUrl) msgParams.statusCallback = statusCallbackUrl;

      const message = await twilio.messages.create(msgParams);
      await pool.query(
        `UPDATE activities SET message_sid=$1, sms_status='sent' WHERE id=$2`,
        [message.sid, act.id]
      );
      res.json({ ok: true, sid: message.sid });
    } catch (twilioErr) {
      await pool.query(
        `UPDATE activities SET sms_status='failed', sms_error=$1 WHERE id=$2`,
        [twilioErr.message, act.id]
      );
      res.status(500).json({ error: twilioErr.message });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SMS STATUS WEBHOOK (Twilio delivery receipts) ────────────────────────────
app.post('/api/twilio/sms-status', async (req, res) => {
  res.sendStatus(200); // Always respond quickly to Twilio
  try {
    const { activityId } = req.query;
    const { MessageStatus, MessageSid, ErrorCode, ErrorMessage } = req.body;
    if (!activityId) return;

    // Twilio statuses: queued → sent → delivered / undelivered / failed
    const statusMap = {
      queued: 'sending',
      accepted: 'sending',
      sending: 'sending',
      sent: 'sent',
      delivered: 'delivered',
      undelivered: 'failed',
      failed: 'failed'
    };
    const mapped = statusMap[MessageStatus] || MessageStatus;
    const errorMsg = ErrorCode ? `Error ${ErrorCode}: ${ErrorMessage || MessageStatus}` : null;

    await pool.query(
      `UPDATE activities SET sms_status=$1, sms_error=$2, message_sid=COALESCE($3, message_sid) WHERE id=$4`,
      [mapped, errorMsg, MessageSid || null, activityId]
    );
  } catch (e) { console.error('SMS status webhook error:', e.message); }
});

// ─── VOICE TWIML ──────────────────────────────────────────────────────────────
app.post('/api/twilio/voice', async (req, res) => {
  try {
    const VoiceResponse = require('twilio').twiml.VoiceResponse;
    const response = new VoiceResponse();
    const { To, CallerId, personId, lineId, agentId } = req.body;
    const callSid = req.body.CallSid;
    if (!To) { response.say('No destination number provided.'); return res.type('xml').send(response.toString()); }
    const dial = response.dial({
      callerId: CallerId || process.env.TWILIO_RESIDENT_NUMBER,
      record: 'record-from-ringing-dual',
      recordingStatusCallback: `${process.env.APP_URL}/api/twilio/recording`,
      recordingStatusCallbackMethod: 'POST'
    });
    dial.number({ statusCallbackEvent: 'initiated ringing answered completed', statusCallback: `${process.env.APP_URL}/api/twilio/status`, statusCallbackMethod: 'POST' }, To);
    // Always create call record so recording webhook can find it
    if (callSid) {
      pool.query(
        'INSERT INTO calls (twilio_call_sid,person_id,agent_id,line_id,direction,status,from_number,to_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (twilio_call_sid) DO NOTHING',
        [callSid, personId||null, agentId||null, lineId||null, 'outbound', 'initiated', CallerId||process.env.TWILIO_RESIDENT_NUMBER, To]
      ).catch(e => console.error('Insert call error:', e.message));
    }
    res.type('xml').send(response.toString());
  } catch (e) { console.error(e); res.status(500).send('<Response><Say>Error</Say></Response>'); }
});

app.post('/api/twilio/inbound', async (req, res) => {
  try {
    const VoiceResponse = require('twilio').twiml.VoiceResponse;
    const response = new VoiceResponse();
    const { To: toNum, From: fromNum, CallSid: callSid } = req.body;
    const lineR = await pool.query('SELECT * FROM call_lines WHERE twilio_number=$1', [toNum]);
    const line = lineR.rows[0];
    // Look up person by any phone number (primary or in person_phones)
    const normalizedFrom = fromNum.replace(/\D/g,'');
    let person = null;
    const ppR = await pool.query(
      `SELECT p.* FROM people p
       JOIN person_phones pp ON pp.person_id = p.id
       WHERE regexp_replace(pp.phone, '\\D', '', 'g') = $1
         AND (pp.is_bad IS NULL OR pp.is_bad=false)
       LIMIT 1`,
      [normalizedFrom]
    );
    if (ppR.rows.length) {
      person = ppR.rows[0];
    } else {
      // Fallback: people.phone column
      const pR = await pool.query(`SELECT * FROM people WHERE regexp_replace(phone,'\\D','','g')=$1 LIMIT 1`, [normalizedFrom]);
      person = pR.rows[0] || null;
    }
    const callInsert = await pool.query(
      'INSERT INTO calls (twilio_call_sid,person_id,line_id,direction,status,from_number,to_number) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [callSid, person?.id||null, line?.id||null, 'inbound', 'ringing', fromNum, toNum]
    );
    let agents = [];
    if (line) {
      const aR = await pool.query('SELECT a.* FROM agents a JOIN line_agents la ON la.agent_id::text=a.id::text WHERE la.line_id=$1 AND a.is_active=true', [line.id]);
      agents = aR.rows;
    }
    if (agents.length === 0) {
      const aR = await pool.query('SELECT * FROM agents WHERE is_active=true');
      agents = aR.rows;
    }
    if (agents.length === 0) {
      response.say('You have reached OKCREAL. Please leave a message after the beep.');
      response.record({ maxLength: 120, recordingStatusCallback: `${process.env.APP_URL}/api/twilio/voicemail?callId=${callInsert.rows[0].id}` });
    } else {
      const dial = response.dial({
        record: 'record-from-ringing-dual',
        recordingStatusCallback: `${process.env.APP_URL}/api/twilio/recording`,
        recordingStatusCallbackMethod: 'POST',
        // action fires when the dial ends — this creates the activity row
        action: `${process.env.APP_URL}/api/twilio/inbound-complete?callSid=${callSid}`,
        method: 'POST',
        timeout: 30
      });
      agents.forEach(a => dial.client(a.id));
    }
    res.type('xml').send(response.toString());
  } catch (e) { console.error(e); res.status(500).send('<Response><Say>Error connecting</Say></Response>'); }
});

app.post('/api/twilio/status', async (req, res) => {
  try {
    const { CallSid, CallStatus, CallDuration } = req.body;
    if (['completed', 'failed', 'busy', 'no-answer'].includes(CallStatus)) {
      const r = await pool.query(
        'UPDATE calls SET status=$1,duration_seconds=$2,ended_at=NOW() WHERE twilio_call_sid=$3 RETURNING *',
        [CallStatus, parseInt(CallDuration)||0, CallSid]
      );
      const call = r.rows[0];
      if (call) {
        pool.query(
          'INSERT INTO activities (person_id,agent_id,call_id,type,body,duration,direction) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [call.person_id, call.agent_id, call.id, 'call', 'Transcript processing...', call.duration_seconds, call.direction||'outbound']
        ).catch(() => {});
      }
    }
    res.sendStatus(200);
  } catch (e) { console.error(e); res.sendStatus(200); }
});

// Fires when inbound <Dial> ends (action URL) — creates the activity for inbound calls
app.post('/api/twilio/inbound-complete', async (req, res) => {
  res.type('xml').send('<Response></Response>'); // must return TwiML
  try {
    const { callSid } = req.query;
    const { DialCallDuration, DialCallStatus } = req.body;
    const duration = parseInt(DialCallDuration) || 0;
    const status = DialCallStatus || 'completed';
    const r = await pool.query(
      'UPDATE calls SET status=$1,duration_seconds=$2,ended_at=NOW() WHERE twilio_call_sid=$3 RETURNING *',
      [status, duration, callSid]
    );
    const call = r.rows[0];
    if (call && call.person_id) {
      await pool.query(
        'INSERT INTO activities (person_id,agent_id,call_id,type,body,duration,direction) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
        [call.person_id, call.agent_id, call.id, 'call', 'Transcript processing...', duration, 'inbound']
      ).catch(() => {});
    }
  } catch (e) { console.error('inbound-complete error:', e.message); }
});

app.post('/api/twilio/recording', async (req, res) => {
  res.sendStatus(200);
  try {
    const { CallSid, ParentCallSid, RecordingUrl, RecordingSid } = req.body;
    console.log('Recording webhook:', { CallSid, ParentCallSid, RecordingUrl: RecordingUrl?.substring(0,60), RecordingSid });
    // Try matching by CallSid, then ParentCallSid (Dial recordings may send child SID)
    let callR = await pool.query('SELECT * FROM calls WHERE twilio_call_sid=$1', [CallSid]);
    if (!callR.rows.length && ParentCallSid) {
      callR = await pool.query('SELECT * FROM calls WHERE twilio_call_sid=$1', [ParentCallSid]);
    }
    const call = callR.rows[0];
    if (!call) {
      console.log('Recording webhook: no call found for SID', CallSid, 'or parent', ParentCallSid);
      return;
    }
    const recUrl = `${RecordingUrl}.mp3`;
    await pool.query('UPDATE calls SET recording_url=$1 WHERE id=$2', [recUrl, call.id]);

    // Ensure activity row exists — recording webhook can arrive before status webhook
    const existingAct = await pool.query('SELECT id FROM activities WHERE call_id=$1 LIMIT 1', [call.id]);
    if (existingAct.rows.length === 0) {
      await pool.query(
        'INSERT INTO activities (person_id,agent_id,call_id,type,body,duration,direction) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
        [call.person_id, call.agent_id, call.id, 'call', 'Transcript processing...', call.duration_seconds||0, call.direction||'outbound']
      ).catch(()=>{});
    }

    let transcript = '', summary = '';
    const dg = initDeepgram();
    if (dg) {
      try {
        const rawUrl = `${recUrl}`;
        // Download recording as buffer with Twilio Basic Auth using https module
        const audioBuffer = await new Promise((resolve, reject) => {
          const https = require('https');
          const url   = new URL(rawUrl);
          const opts  = {
            hostname: url.hostname,
            path:     url.pathname + url.search,
            method:   'GET',
            headers:  { Authorization: 'Basic ' + twilioBasicAuth() }
          };
          const req = https.request(opts, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Twilio fetch failed: ${res.statusCode}`)); }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end',  () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
          });
          req.on('error', reject);
          req.end();
        });
        console.log(`Deepgram: fetched ${audioBuffer.length} bytes, sending to transcription`);
        const { result } = await dg.listen.prerecorded.transcribeFile(
          audioBuffer,
          { model: 'nova-2', smart_format: true, diarize: true, punctuate: true, utterances: true, mimetype: 'audio/mpeg' }
        );
        const utterances = result?.results?.utterances;
        if (utterances?.length) {
          transcript = utterances.map(u => {
            const ts = `[${Math.floor(u.start/60)}:${String(Math.floor(u.start%60)).padStart(2,'0')}]`;
            return `${ts} ${u.channel === 0 ? 'Agent' : 'Caller'}: ${u.transcript}`;
          }).join('\n');
        } else {
          transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
        }
        console.log(`Deepgram: transcript length ${transcript.length}`);
      } catch (e) { console.error('Deepgram error:', e.message, e.stack?.split('\n')[1] || ''); }
    } else {
      console.warn('Deepgram: no API key set, skipping transcription');
    }
    const grok = initGrok();
    if (grok && transcript.length > 20) {
      try {
        const personR = call.person_id ? await pool.query('SELECT first_name,last_name FROM people WHERE id=$1', [call.person_id]) : null;
        const agentR = call.agent_id ? await pool.query('SELECT name FROM agents WHERE id::text=$1', [call.agent_id]) : null;
        const contactName = personR?.rows[0] ? `${personR.rows[0].first_name} ${personR.rows[0].last_name||''}`.trim() : 'Unknown';
        const agentName = agentR?.rows[0]?.name || 'Agent';
        const completion = await grok.chat.completions.create({
          model: 'grok-3', max_tokens: 200,
          messages: [
            { role: 'system', content: 'You summarize property management calls in 2-3 sentences. Focus on: payment commitments, maintenance issues, lease inquiries, delinquency resolutions, action items.' },
            { role: 'user', content: `${call.direction === 'inbound' ? 'Inbound' : 'Outbound'} call. Agent: ${agentName}. Contact: ${contactName}.\n\nTranscript:\n${transcript}` }
          ]
        });
        summary = completion.choices[0]?.message?.content || '';
      } catch (e) { console.error('Grok error:', e.message); }
    }
    await pool.query('UPDATE calls SET transcript=$1,summary=$2 WHERE id=$3', [transcript, summary, call.id]);
    // Always update the activity — even if blank, clear "Transcript processing..." placeholder
    const activityBody = summary || (transcript ? transcript.substring(0, 300) : 'Call recorded. No transcript available.');
    // Also save recording_url directly on activity so JOIN isn't required to show it
    await pool.query('UPDATE activities SET body=$1, recording_url=$2 WHERE call_id=$3', [activityBody, recUrl, call.id]).catch((e) => { console.error('Activity update error:', e.message); });
  } catch (e) { console.error('Recording webhook error:', e.message); }
});

// Retry transcription for stuck "Transcript processing..." activities
app.post('/api/twilio/recording/retry/:callId', auth, async (req, res) => {
  try {
    const callR = await pool.query('SELECT * FROM calls WHERE id=$1', [req.params.callId]);
    const call = callR.rows[0];
    if (!call?.recording_url) return res.status(404).json({ error: 'No recording found' });
    res.json({ ok: true, message: 'Retrying transcription...' });
    // Run async
    (async () => {
      let transcript = '', summary = '';
      const dg = initDeepgram();
      if (dg) {
        try {
          const audioBuffer = await new Promise((resolve, reject) => {
            const https = require('https');
            const url   = new URL(call.recording_url);
            const opts  = {
              hostname: url.hostname,
              path:     url.pathname + url.search,
              method:   'GET',
              headers:  { Authorization: 'Basic ' + twilioBasicAuth() }
            };
            const req = https.request(opts, (res) => {
              if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Twilio fetch failed: ${res.statusCode}`)); }
              const chunks = [];
              res.on('data', c => chunks.push(c));
              res.on('end',  () => resolve(Buffer.concat(chunks)));
              res.on('error', reject);
            });
            req.on('error', reject);
            req.end();
          });
          console.log(`Retry Deepgram: fetched ${audioBuffer.length} bytes`);
          const { result } = await dg.listen.prerecorded.transcribeFile(
            audioBuffer,
            { model: 'nova-2', smart_format: true, diarize: true, punctuate: true, utterances: true, mimetype: 'audio/mpeg' }
          );
          const utterances = result?.results?.utterances;
          if (utterances?.length) {
            transcript = utterances.map(u => {
              const ts = `[${Math.floor(u.start/60)}:${String(Math.floor(u.start%60)).padStart(2,'0')}]`;
              return `${ts} ${u.channel === 0 ? 'Agent' : 'Caller'}: ${u.transcript}`;
            }).join('\n');
          } else {
            transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
          }
        } catch(e) { console.error('Retry Deepgram error:', e.message, e.stack?.split('\n')[1] || ''); }
      }
      const grok = initGrok();
      if (grok && transcript.length > 20) {
        try {
          const personR = call.person_id ? await pool.query('SELECT first_name,last_name FROM people WHERE id=$1', [call.person_id]) : null;
          const agentR = call.agent_id ? await pool.query('SELECT name FROM agents WHERE id::text=$1', [call.agent_id]) : null;
          const contactName = personR?.rows[0] ? `${personR.rows[0].first_name} ${personR.rows[0].last_name||''}`.trim() : 'Unknown';
          const agentName = agentR?.rows[0]?.name || 'Agent';
          const completion = await grok.chat.completions.create({
            model: 'grok-3', max_tokens: 200,
            messages: [
              { role: 'system', content: 'You summarize property management calls in 2-3 sentences. Focus on: payment commitments, maintenance issues, lease inquiries, delinquency resolutions, action items.' },
              { role: 'user', content: `${call.direction === 'inbound' ? 'Inbound' : 'Outbound'} call. Agent: ${agentName}. Contact: ${contactName}.\n\nTranscript:\n${transcript}` }
            ]
          });
          summary = completion.choices[0]?.message?.content || '';
        } catch(e) { console.error('Retry Grok error:', e.message); }
      }
      await pool.query('UPDATE calls SET transcript=$1,summary=$2 WHERE id=$3', [transcript, summary, call.id]);
      const body = summary || (transcript ? transcript.substring(0, 300) : 'Call recorded. Transcript unavailable.');
      await pool.query('UPDATE activities SET body=$1 WHERE call_id=$2', [body, call.id]).catch(() => {});
    })();
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RECORDING PROXY — serves Twilio recordings with embedded auth so browser audio player works ──
// Uses query param token (?token=JWT) because HTML <audio> elements can't send Authorization headers
app.get('/api/calls/:callId/recording', async (req, res) => {
  try {
    // Accept token from Authorization header OR ?token= query param (needed for <audio src>)
    const headerToken = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    const queryToken  = req.query.token || null;
    const token = headerToken || queryToken;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    let agentId;
    try { agentId = jwt.verify(token, JWT_SECRET).id; } catch(e) { return res.status(401).json({ error: 'Unauthorized' }); }
    const agentR = await pool.query('SELECT id FROM agents WHERE id=$1 AND is_active=true', [agentId]);
    if (!agentR.rows[0]) return res.status(401).json({ error: 'Unauthorized' });

    // Look up recording_url — check calls table first, then activities table
    // (some recordings land only on activities.recording_url)
    const callR = await pool.query(
      `SELECT COALESCE(c.recording_url, a.recording_url) AS recording_url
       FROM calls c
       LEFT JOIN activities a ON a.call_id::text = c.id::text
       WHERE c.id::text = $1
       LIMIT 1`,
      [req.params.callId]
    );
    let recUrl = callR.rows[0]?.recording_url;

    // Fallback: callId might be an activity id — look up via activities directly
    if (!recUrl) {
      const actR = await pool.query(
        `SELECT COALESCE(a.recording_url, c.recording_url) AS recording_url
         FROM activities a
         LEFT JOIN calls c ON c.id::text = a.call_id::text
         WHERE a.id::text = $1 OR a.call_id::text = $1
         LIMIT 1`,
        [req.params.callId]
      );
      recUrl = actR.rows[0]?.recording_url;
    }

    if (!recUrl) return res.status(404).json({ error: 'No recording found for this call' });
    const auth = twilioBasicAuth();
    if (!auth) return res.status(500).json({ error: 'Twilio credentials not configured' });
    const https = require('https');
    const url   = new URL(recUrl);
    const opts  = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  { Authorization: 'Basic ' + auth }
    };
    const upstream = await new Promise((resolve, reject) => {
      const r = https.request(opts, resolve);
      r.on('error', reject);
      r.end();
    });
    if (upstream.statusCode !== 200) {
      upstream.resume();
      return res.status(502).json({ error: `Twilio returned ${upstream.statusCode}` });
    }
    res.set('Content-Type', upstream.headers['content-type'] || 'audio/mpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    upstream.pipe(res);
  } catch(e) { console.error('Recording proxy error:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/twilio/voicemail', async (req, res) => {
  res.sendStatus(200);
  try {
    const { callId } = req.query;
    const { RecordingUrl } = req.body;
    if (!callId) return;
    await pool.query('UPDATE calls SET status=$1,recording_url=$2 WHERE id=$3', ['voicemail', `${RecordingUrl}.mp3`, callId]);
    const callR = await pool.query('SELECT * FROM calls WHERE id=$1', [callId]);
    const call = callR.rows[0];
    if (call) {
      pool.query(
        'INSERT INTO activities (person_id,call_id,type,body,recording_url) VALUES($1,$2,$3,$4,$5)',
        [call.person_id, call.id, 'voicemail', 'Voicemail received', `${RecordingUrl}.mp3`]
      ).catch(() => {});
    }
  } catch (e) { console.error('Voicemail error:', e.message); }
});

// ─── ADMIN ────────────────────────────────────────────────────────────────────
// ─── CONFIG / CLIENT KEYS ─────────────────────────────────────────────────────
app.get('/api/config/maps-key', auth, (req, res) => {
  res.json({ key: process.env.GOOGLE_MAPS_API_KEY || null });
});

app.get('/api/admin/agents', auth, adminOnly, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,name,email,role,phone,avatar_color,is_active,created_at FROM agents ORDER BY name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Also expose without /admin prefix for frontend compatibility
// ── FUB IMPORT ────────────────────────────────────────────────────────────────
const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function fubParseCSV(raw) {
  // Strip UTF-8 BOM, normalize line endings
  const cleaned = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // RFC-4180 compliant parser — handles quoted fields with embedded newlines/commas
  const rows2D = [[]];
  let cur = '', inQ = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '"') {
      if (!inQ) { inQ = true; continue; }
      if (cleaned[i+1] === '"') { cur += '"'; i++; continue; } // escaped quote
      inQ = false; continue;
    }
    if (!inQ && ch === ',')  { rows2D[rows2D.length-1].push(cur); cur = ''; continue; }
    if (!inQ && ch === '\n') { rows2D[rows2D.length-1].push(cur); cur = ''; rows2D.push([]); continue; }
    cur += ch;
  }
  rows2D[rows2D.length-1].push(cur);

  const headers = rows2D[0].map(h => h.trim());
  const result = [];
  for (let r = 1; r < rows2D.length; r++) {
    const vals = rows2D[r];
    if (vals.every(v => !v.trim())) continue;
    const row = {};
    headers.forEach((h, j) => { row[h] = (vals[j] || '').trim(); });
    result.push(row);
  }
  return result;
}

function fubMapStage(s) {
  const v = (s||'').toLowerCase().trim();
  if (!v) return 'Lead';
  if (['hot','warm','cold','nurture','active','rental prospect','prospect','new',
       'uncontacted','attempted contact','pre-approval','showing scheduled'].includes(v)) return 'Lead';
  if (['past client','past tenant','past buyer','past seller','closed','purchased','sold'].includes(v)) return 'Past Tenant';
  if (['owner','property owner','landlord'].includes(v)) return 'Property Owner';
  if (['resident','tenant','active tenant','current tenant'].includes(v)) return 'Resident';
  if (['contractor','vendor','maintenance'].includes(v)) return 'Contractor';
  if (['caseworker','case worker','social worker','hap','section 8'].includes(v)) return 'Caseworker';
  return 'Lead';
}

function fubIsBlocked(s) {
  return ['trash','do not contact','dnc','spam','blocked'].includes((s||'').toLowerCase().trim());
}

function fubNormalizePhone(ph) {
  if (!ph) return null;
  const d = ph.replace(/\D/g,'');
  if (d.length===10) return '+1'+d;
  if (d.length===11 && d[0]==='1') return '+'+d;
  return null;
}

function fubParseDOB(val) {
  if (!val) return null;
  const m = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  return null;
}

app.post('/api/import/fub', auth, uploadMemory.single('csv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });
    const commit = req.body.commit === '1';
    const raw = req.file.buffer.toString('utf8');
    const csvRows = fubParseCSV(raw);

    // Helper: truncate to safe length (TEXT cols are unlimited after migration, but be safe)
    const trunc = (s, n=1000) => s ? String(s).substring(0, n) : s;

    const contacts = csvRows.map(row => ({
      first_name:  trunc(row['First Name'] || (row['Name']||'').split(' ')[0] || '', 200),
      last_name:   trunc(row['Last Name']  || (row['Name']||'').split(' ').slice(1).join(' ') || '', 200),
      fub_id:      trunc(row['ID'] || null, 100),
      email:       trunc((row['Email 1'] || row['Email'] || '').toLowerCase() || null, 300),
      phone:       fubNormalizePhone(row['Phone 1'] || row['Phone']),
      phone_type:  trunc(row['Phone 1 - Type'] || 'mobile', 50),
      fub_stage:   trunc(row['Stage'] || '', 100),
      stage:       fubMapStage(row['Stage']),
      is_blocked:  fubIsBlocked(row['Stage']),
      source:      trunc(row['Lead Source'] || null, 200),
      tags:        row['Tags'] ? row['Tags'].split(',').map(t=>t.trim()).filter(Boolean) : [],
      notes:       [row['Notes'],row['Description'],row['Background']].filter(Boolean).join('\n\n') || null,
      dob:         fubParseDOB(row['DOB:'] || row['Birthday'] || row['DOB']),
      address:     trunc(row['Property Address'] || row['Address'] || null, 300),
      city:        trunc(row['Property City'] || row['City'] || null, 100),
      state:       trunc(row['Property State'] || row['State'] || null, 50),
      zip:         trunc(row['Property Postal Code'] || row['Zip'] || null, 20),
    })).filter(c => c.first_name);

    // Load existing for dedup
    const existingByFubId = new Map();
    const existingByEmail = new Map();
    const existingByPhone = new Map();
    const { rows: existing } = await pool.query(`
      SELECT p.id, p.fub_id, p.email, p.phone AS main_phone,
             array_agg(pp.phone) FILTER (WHERE pp.phone IS NOT NULL) AS phones
      FROM people p LEFT JOIN person_phones pp ON pp.person_id = p.id
      GROUP BY p.id
    `);
    const normalizeForDedup = ph => {
      if (!ph) return null;
      const d = String(ph).replace(/\D/g,'');
      if (d.length === 10) return '+1' + d;
      if (d.length === 11 && d[0] === '1') return '+' + d;
      return d || null;
    };
    for (const p of existing) {
      if (p.fub_id) existingByFubId.set(String(p.fub_id).trim(), p.id);
      if (p.email)  existingByEmail.set(p.email.toLowerCase().trim(), p.id);
      // Index both the main phone column and all person_phones entries
      const allPhones = [...(p.phones || [])];
      if (p.main_phone) allPhones.push(p.main_phone);
      for (const ph of allPhones) {
        const norm = normalizeForDedup(ph);
        if (norm) existingByPhone.set(norm, p.id);
      }
    }

    let inserted = 0, updated = 0, skipped = 0, blocked = 0;
    const preview = [];

    for (const c of contacts) {
      if (!c.first_name) { skipped++; continue; }
      let existingId = null;
      if (c.fub_id && existingByFubId.has(c.fub_id))        existingId = existingByFubId.get(c.fub_id);
      else if (c.email && existingByEmail.has(c.email))      existingId = existingByEmail.get(c.email);
      else if (c.phone && existingByPhone.has(c.phone))      existingId = existingByPhone.get(c.phone);

      const name = `${c.first_name} ${c.last_name||''}`.trim();
      if (c.is_blocked) blocked++;

      if (existingId) {
        updated++;
        preview.push({ action:'update', name, stage:c.stage, phone:c.phone, email:c.email, fub_stage:c.fub_stage, is_blocked:c.is_blocked });
        if (commit) {
          await pool.query(`UPDATE people SET fub_id=COALESCE(fub_id,$1), dob=COALESCE(dob,$2), source=COALESCE(source,$3),
            notes=COALESCE(NULLIF(notes,''),$4), is_blocked=is_blocked OR $5, updated_at=NOW() WHERE id=$6`,
            [c.fub_id, c.dob||null, c.source||null, c.notes||null, c.is_blocked, existingId]);
          if (c.phone) await pool.query(
            `INSERT INTO person_phones (person_id,phone,label,is_primary) VALUES ($1,$2,$3,false) ON CONFLICT DO NOTHING`,
            [existingId, c.phone, c.phone_type||'mobile']);
        }
      } else {
        inserted++;
        preview.push({ action:'insert', name, stage:c.stage, phone:c.phone, email:c.email, fub_stage:c.fub_stage, is_blocked:c.is_blocked });
        if (commit) {
          const { rows:[np] } = await pool.query(`
            INSERT INTO people (first_name,last_name,email,stage,source,tags,notes,dob,fub_id,is_blocked,address,city,state,zip)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
            [c.first_name, c.last_name||null, c.email||null, c.stage, c.source||null,
             c.tags||[], c.notes||null, c.dob||null, c.fub_id||null, c.is_blocked||false,
             c.address||null, c.city||null, c.state||null, c.zip||null]);
          if (c.phone && np) await pool.query(
            `INSERT INTO person_phones (person_id,phone,label,is_primary) VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING`,
            [np.id, c.phone, c.phone_type||'mobile']);
        }
      }
    }

    res.json({ inserted, updated, skipped, blocked, commit, total: contacts.length, preview: preview.slice(0, 200) });
  } catch(e) { console.error('FUB import error:', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/agents', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,name,email,role,phone,avatar_color,is_active,created_at FROM agents ORDER BY name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/call-lines', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM call_lines WHERE is_active=true ORDER BY name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents', auth, adminOnly, async (req, res) => {
  try {
    const { name, email, password, role, phone, avatarColor } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO agents (name,email,password_hash,role,phone,avatar_color) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,phone,avatar_color,is_active',
      [name, email, hash, role||'agent', phone||null, avatarColor||'#6366f1']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/agents/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, email, role, phone, isActive, avatarColor, password } = req.body;
    let hash;
    if (password) hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `UPDATE agents SET name=$1,email=$2,role=$3,phone=$4,is_active=$5,avatar_color=$6${hash?',password_hash=$8':''} WHERE id=$7 RETURNING id,name,email,role,phone,avatar_color,is_active`,
      hash ? [name,email,role,phone,isActive,avatarColor,req.params.id,hash] : [name,email,role,phone,isActive,avatarColor,req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/lines', auth, adminOnly, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT cl.*, COALESCE(json_agg(json_build_object('id',a.id,'name',a.name)) FILTER (WHERE a.id IS NOT NULL),'[]') as agents
      FROM call_lines cl
      LEFT JOIN line_agents la ON la.line_id=cl.id
      LEFT JOIN agents a ON a.id::text=la.agent_id::text
      GROUP BY cl.id ORDER BY cl.name`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/lines', auth, adminOnly, async (req, res) => {
  try {
    const { name, twilioNumber, description } = req.body;
    const r = await pool.query('INSERT INTO call_lines (name,twilio_number,description) VALUES($1,$2,$3) RETURNING *', [name, twilioNumber, description]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/lines/:id/agents', auth, adminOnly, async (req, res) => {
  try {
    const { agentIds } = req.body;
    await pool.query('DELETE FROM line_agents WHERE line_id=$1', [req.params.id]);
    if (agentIds?.length) {
      for (const aid of agentIds) {
        await pool.query('INSERT INTO line_agents (line_id,agent_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.params.id, aid]);
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
  try {
    const stages = await pool.query('SELECT stage, COUNT(*) FROM people GROUP BY stage');
    const tasks = await pool.query('SELECT COUNT(*) FROM tasks WHERE completed=false');
    res.json({ stages: stages.rows, openTasks: tasks.rows[0].count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DB INIT ──────────────────────────────────────────────────────────────────
async function initDB() {
  const run = async (sql, label) => {
    try { await pool.query(sql); }
    catch (e) { console.error(`[DB] ${label}: ${e.message}`); }
  };

  await run(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`, 'uuid-ossp');

  await run(`
    CREATE TABLE IF NOT EXISTS agents (
      id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT DEFAULT 'agent',
      phone         TEXT,
      avatar_color  TEXT DEFAULT '#6366f1',
      is_active     BOOLEAN DEFAULT true,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `, 'create agents');

  await run(`
    CREATE TABLE IF NOT EXISTS people (
      id            SERIAL PRIMARY KEY,
      first_name    TEXT NOT NULL,
      last_name     TEXT,
      phone         TEXT,
      email         TEXT,
      stage         TEXT DEFAULT 'lead',
      source        TEXT,
      background    TEXT,
      tags          TEXT[] DEFAULT '{}',
      custom_fields JSONB DEFAULT '{}',
      assigned_to   TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `, 'create people');

  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS background TEXT`, 'people.background');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'`, 'people.tags');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS custom_fields JSONB DEFAULT '{}'`, 'people.custom_fields');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`, 'people.updated_at');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS assigned_to TEXT`, 'people.assigned_to');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS source TEXT`, 'people.source');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS stage TEXT DEFAULT 'lead'`, 'people.stage');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS unifi_person_id TEXT`, 'people.unifi_person_id');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS id_photo_b64 TEXT`, 'people.id_photo_b64');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS id_photo_name TEXT`, 'people.id_photo_name');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS security_notes TEXT`, 'people.security_notes');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS criminal_history TEXT`, 'people.criminal_history');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS dv_victim BOOLEAN DEFAULT FALSE`, 'people.dv_victim');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS dv_notes TEXT`, 'people.dv_notes');

  // ── Security events table ──
  await run(`
    CREATE TABLE IF NOT EXISTS security_events (
      id            SERIAL PRIMARY KEY,
      event_id      TEXT UNIQUE,
      unifi_person_id TEXT,
      camera_mac    TEXT,
      camera_name   TEXT,
      site          TEXT,
      event_link    TEXT,
      thumbnail_b64 TEXT,
      triggered_at  TIMESTAMPTZ DEFAULT NOW(),
      alarm_name    TEXT,
      raw_payload   TEXT,
      dismissed     BOOLEAN DEFAULT FALSE
    )
  `, 'create security_events');

  // ── Camera name mapping table ──
  await run(`
    CREATE TABLE IF NOT EXISTS protect_cameras (
      id    SERIAL PRIMARY KEY,
      mac   TEXT UNIQUE NOT NULL,
      name  TEXT NOT NULL,
      site  TEXT DEFAULT 'Main'
    )
  `, 'create protect_cameras');
  // Seed known camera names (MAC → friendly name from UniFi Protect device list)
  // Add entries here as you identify each camera MAC from the Protect devices page
  const knownCams = [
    ['847848B2C827', 'Marlin Rear Overwatch', 'Marlin'],
  ];
  for (const [mac, name, site] of knownCams) {
    await pool.query(
      `INSERT INTO protect_cameras (mac,name,site) VALUES($1,$2,$3) ON CONFLICT (mac) DO NOTHING`,
      [mac, name, site]
    ).catch(()=>{});
  }
  // Migrate old stage names
  await run(`UPDATE people SET stage='Resident' WHERE stage='Active Tenant'`, 'migrate stage Active Tenant->Resident').catch(()=>{});
  await run(`UPDATE people SET stage='Contractor' WHERE stage='Vendor'`, 'migrate stage Vendor->Contractor').catch(()=>{});
  // Fix any security_events where event_link doesn't contain the event_id (was stored as list URL)
  if (process.env.PROTECT_CLOUD_BASE_URL) {
    await pool.query(`
      UPDATE security_events
      SET event_link = $1 || '/protect/events/event/' || event_id
      WHERE event_id IS NOT NULL
        AND (event_link IS NULL OR event_link NOT LIKE '%/event/%')
    `, [process.env.PROTECT_CLOUD_BASE_URL]).catch(e => console.warn('Fix event_links:', e.message));
  }
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS address TEXT`, 'people.address');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS city TEXT`, 'people.city');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS state TEXT`, 'people.state');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS zip TEXT`, 'people.zip');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS fub_id TEXT`, 'people.fub_id');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS dob DATE`, 'people.dob');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT FALSE`, 'people.is_blocked');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS notes TEXT`, 'people.notes');
  // Widen any VARCHAR columns to TEXT so long FUB values don't error
  await run(`ALTER TABLE people ALTER COLUMN first_name TYPE TEXT`, 'people.first_name->TEXT');
  await run(`ALTER TABLE people ALTER COLUMN last_name TYPE TEXT`, 'people.last_name->TEXT');
  await run(`ALTER TABLE people ALTER COLUMN phone TYPE TEXT`, 'people.phone->TEXT');
  await run(`ALTER TABLE people ALTER COLUMN email TYPE TEXT`, 'people.email->TEXT');
  await run(`ALTER TABLE people ALTER COLUMN stage TYPE TEXT`, 'people.stage->TEXT');
  await run(`ALTER TABLE people ALTER COLUMN source TYPE TEXT`, 'people.source->TEXT');
  await run(`ALTER TABLE people ALTER COLUMN background TYPE TEXT`, 'people.background->TEXT');
  await run(`ALTER TABLE people ALTER COLUMN assigned_to TYPE TEXT`, 'people.assigned_to->TEXT');
  await run(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS inbox_cleared BOOLEAN DEFAULT FALSE`, 'calls.inbox_cleared');
  await run(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`, 'calls.created_at');
  await run(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS inbox_cleared BOOLEAN DEFAULT FALSE`, 'activities.inbox_cleared');

  // Multi-phone support
  await run(`
    CREATE TABLE IF NOT EXISTS person_phones (
      id          SERIAL PRIMARY KEY,
      person_id   INTEGER REFERENCES people(id) ON DELETE CASCADE,
      phone       TEXT NOT NULL,
      label       TEXT DEFAULT 'mobile',
      is_primary  BOOLEAN DEFAULT FALSE,
      is_bad      BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `, 'create person_phones');
  await run(`CREATE INDEX IF NOT EXISTS idx_person_phones_person ON person_phones(person_id)`, 'idx_person_phones');

  // Household / relationship support
  await run(`
    CREATE TABLE IF NOT EXISTS person_relationships (
      id              SERIAL PRIMARY KEY,
      person_id_a     INTEGER REFERENCES people(id) ON DELETE CASCADE,
      person_id_b     INTEGER REFERENCES people(id) ON DELETE CASCADE,
      label           TEXT DEFAULT 'household',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(person_id_a, person_id_b)
    )
  `, 'create person_relationships');
  await run(`CREATE INDEX IF NOT EXISTS idx_rels_a ON person_relationships(person_id_a)`, 'idx_rels_a');
  await run(`CREATE INDEX IF NOT EXISTS idx_rels_b ON person_relationships(person_id_b)`, 'idx_rels_b');

  await run(`
    CREATE TABLE IF NOT EXISTS call_lines (
      id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name          TEXT NOT NULL,
      twilio_number TEXT NOT NULL,
      description   TEXT,
      is_active     BOOLEAN DEFAULT true,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `, 'create call_lines');

  await run(`
    CREATE TABLE IF NOT EXISTS line_agents (
      line_id  TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      PRIMARY KEY (line_id, agent_id)
    )
  `, 'create line_agents');

  await run(`
    CREATE TABLE IF NOT EXISTS smart_lists (
      id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name       TEXT NOT NULL,
      filters    JSONB DEFAULT '{}',
      sort_order INTEGER DEFAULT 0
    )
  `, 'create smart_lists');

  await run(`
    CREATE TABLE IF NOT EXISTS custom_fields (
      id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      key        TEXT UNIQUE NOT NULL,
      label      TEXT NOT NULL,
      field_type TEXT DEFAULT 'text',
      options    TEXT[],
      sort_order INTEGER DEFAULT 0
    )
  `, 'create custom_fields');

  await run(`
    CREATE TABLE IF NOT EXISTS calls (
      id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      twilio_call_sid  TEXT UNIQUE,
      person_id        TEXT,
      agent_id         TEXT,
      line_id          TEXT,
      direction        TEXT,
      status           TEXT,
      duration_seconds INTEGER,
      from_number      TEXT,
      to_number        TEXT,
      recording_url    TEXT,
      recording_sid    TEXT,
      transcript       TEXT,
      summary          TEXT,
      started_at       TIMESTAMPTZ DEFAULT NOW(),
      ended_at         TIMESTAMPTZ
    )
  `, 'create calls');

  await run(`
    CREATE TABLE IF NOT EXISTS activities (
      id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      person_id     TEXT,
      agent_id      TEXT,
      call_id       TEXT,
      type          TEXT NOT NULL DEFAULT 'note',
      body          TEXT,
      duration      INTEGER,
      recording_url TEXT,
      direction     TEXT DEFAULT 'outbound',
      sms_status    TEXT DEFAULT NULL,
      sms_error     TEXT DEFAULT NULL,
      message_sid   TEXT DEFAULT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `, 'create activities');

  // Add new columns to existing activities table if they don't exist
  await run(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS direction TEXT DEFAULT 'outbound'`, 'activities.direction');
  await run(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS sms_status TEXT DEFAULT NULL`, 'activities.sms_status');
  await run(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS sms_error TEXT DEFAULT NULL`, 'activities.sms_error');
  await run(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS message_sid TEXT DEFAULT NULL`, 'activities.message_sid');

  await run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      person_id    TEXT,
      agent_id     TEXT,
      title        TEXT NOT NULL,
      note         TEXT,
      due_date     DATE,
      completed    BOOLEAN DEFAULT false,
      completed_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `, 'create tasks');

  // Seed admin
  try {
    const exists = await pool.query(`SELECT 1 FROM agents WHERE email='admin@okcreal.com'`);
    if (exists.rows.length === 0) {
      const hash = await bcrypt.hash('password', 10);
      await pool.query(
        `INSERT INTO agents (name,email,password_hash,role) VALUES ('Admin','admin@okcreal.com',$1,'admin')`,
        [hash]
      );
      console.log('[DB] Admin seeded');
    }
  } catch (e) { console.error('[DB] seed admin:', e.message); }

  // Seed smart lists
  try {
    await pool.query(`
      INSERT INTO smart_lists (name,filters,sort_order) VALUES
        ('Delinquent Residents','{}',0),('Active Residents','{}',1),
        ('Active Leads','{}',2),('Past Clients','{}',3)
      ON CONFLICT DO NOTHING
    `);
  } catch (e) { console.error('[DB] seed smart_lists:', e.message); }

  // Seed custom fields
  try {
    await pool.query(`
      INSERT INTO custom_fields (key,label,field_type,sort_order) VALUES
        ('past_due_balance','Past Due Balance','number',0),
        ('payment_commitment_date','Payment Commitment Date','date',1),
        ('unit_number','Unit Number','text',2),
        ('lease_end_date','Lease End Date','date',3)
      ON CONFLICT (key) DO NOTHING
    `);
  } catch (e) { console.error('[DB] seed custom_fields:', e.message); }

  // Seed call line + link admin agent to it
  try {
    // Remove duplicate lines, keep only the oldest
    // Dedup: keep the row with the smallest id (text sort) per twilio_number
    await pool.query(`
      DELETE FROM call_lines
      WHERE id::text NOT IN (
        SELECT MIN(id::text) FROM call_lines GROUP BY twilio_number
      )
    `).catch(e => console.warn('[DB] dedup call_lines:', e.message));
    // Insert line if not exists
    await pool.query(`
      INSERT INTO call_lines (name,twilio_number,description)
      VALUES ('OKCREAL Connect Line','+14052562614','Main OKCREAL line')
      ON CONFLICT DO NOTHING
    `);
    // Link ALL active agents to the line automatically
    const lineR = await pool.query(`SELECT id FROM call_lines WHERE twilio_number='+14052562614' LIMIT 1`);
    const agentsR = await pool.query(`SELECT id FROM agents WHERE is_active=true`);
    if (lineR.rows[0]) {
      for (const agent of agentsR.rows) {
        await pool.query(
          `INSERT INTO line_agents (line_id,agent_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [lineR.rows[0].id, agent.id]
        ).catch(() => {});
      }
      console.log(`[DB] Linked ${agentsR.rows.length} agent(s) to call line`);
    }
  } catch (e) { console.error('[DB] seed call_lines:', e.message); }

  console.log('[DB] Init complete');
}

// ══════════════════════════════════════════════════════════════════════════
// JIREH SECURITY — UniFi Protect Webhook + SSE
// ══════════════════════════════════════════════════════════════════════════

// SSE stream — browsers connect here for real-time security events
app.get('/api/security/stream', auth, (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();
  res.write(':ok\n\n'); // initial ping

  const client = { res, agentId: req.agent?.id };
  sseClients.add(client);

  // Keepalive ping every 25s
  const ping = setInterval(() => {
    try { res.write(':ping\n\n'); } catch(e) { clearInterval(ping); sseClients.delete(client); }
  }, 25000);

  req.on('close', () => { clearInterval(ping); sseClients.delete(client); });
});

// Recent security events (last 50)
// DEBUG — expose raw webhook payloads to diagnose event_link URL structure
app.get('/api/security/events/raw', auth, adminOnly, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, event_id, event_link, camera_mac, site, raw_payload FROM security_events ORDER BY triggered_at DESC LIMIT 5');
    res.json(r.rows.map(row => ({
      id: row.id,
      event_id: row.event_id,
      event_link: row.event_link,
      camera_mac: row.camera_mac,
      site: row.site,
      payload: row.raw_payload ? JSON.parse(row.raw_payload) : null
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/security/events', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT se.*,
             p.first_name, p.last_name, p.id as person_id, p.stage,
             COALESCE(pc.name, se.camera_name) AS camera_name,
             COALESCE(pc.site, se.site)         AS site
      FROM security_events se
      LEFT JOIN people p          ON p.unifi_person_id = se.unifi_person_id
      LEFT JOIN protect_cameras pc ON pc.mac = se.camera_mac
      ORDER BY se.triggered_at DESC LIMIT 50
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Camera name mapping (admin)
app.get('/api/admin/cameras', auth, adminOnly, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM protect_cameras ORDER BY site, name');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/cameras', auth, adminOnly, async (req, res) => {
  const { mac, name, site } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO protect_cameras (mac,name,site) VALUES($1,$2,$3)
       ON CONFLICT (mac) DO UPDATE SET name=$2, site=$3 RETURNING *`,
      [mac.toUpperCase(), name, site || 'Main']
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/cameras/:mac', auth, adminOnly, async (req, res) => {
  const { name, site } = req.body;
  try {
    const r = await pool.query(
      `INSERT INTO protect_cameras (mac,name,site) VALUES($1,$2,$3)
       ON CONFLICT (mac) DO UPDATE SET name=$2, site=COALESCE($3, protect_cameras.site) RETURNING *`,
      [req.params.mac.toUpperCase(), name, site || null]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/cameras/:id', auth, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM protect_cameras WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});
// Bulk upsert cameras from UniFi Protect (sent from browser)
app.post('/api/admin/cameras/bulk', auth, adminOnly, async (req, res) => {
  const { cameras } = req.body; // [{mac, name, site}]
  if (!Array.isArray(cameras)) return res.status(400).json({ error: 'cameras array required' });
  let saved = 0;
  for (const cam of cameras) {
    if (!cam.mac) continue;
    const mac = cam.mac.replace(/:/g, '').toUpperCase();
    await pool.query(
      `INSERT INTO protect_cameras (mac, name, site) VALUES($1,$2,$3)
       ON CONFLICT (mac) DO UPDATE SET name=EXCLUDED.name, site=COALESCE(EXCLUDED.site, protect_cameras.site)`,
      [mac, cam.name || mac, cam.site || 'Marlin']
    ).catch(() => {});
    saved++;
  }
  res.json({ saved });
});

// Seed protect_cameras from all known MACs in security_events
app.post('/api/admin/cameras/discover', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT camera_mac AS mac, site FROM security_events
      WHERE camera_mac IS NOT NULL AND camera_mac != ''
    `);
    let added = 0;
    for (const row of rows) {
      const r = await pool.query(
        `INSERT INTO protect_cameras (mac, name, site) VALUES($1,$2,$3) ON CONFLICT (mac) DO NOTHING RETURNING id`,
        [row.mac.toUpperCase(), row.mac.toUpperCase(), row.site || 'Main']
      );
      if (r.rowCount) added++;
    }
    res.json({ discovered: rows.length, added });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── UniFi Protect Webhook receiver ───────────────────────────────────────
// Set Delivery URL in UniFi Protect to:
//   https://connect.okcreal.com/api/protect/webhook?token=YOUR_SECRET
app.post('/api/protect/webhook', async (req, res) => {
  // Token verification
  const secret = process.env.PROTECT_WEBHOOK_SECRET;
  if (secret) {
    const provided = req.query.token || req.headers['x-webhook-token'];
    if (provided !== secret) {
      console.warn('[Jireh] Webhook rejected — bad token');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const body = req.body;
    const alarm  = body?.alarm || {};
    const trigger = alarm.triggers?.[0] || {};
    const eventId  = trigger.eventId || body.eventId || null;
    const deviceMac = (trigger.device || '').toUpperCase();
    const ts        = trigger.timestamp || body.timestamp || Date.now();
    const eventPath = alarm.eventPath || null;
    const localLink = alarm.eventLocalLink || null;

    // Build cloud link — construct deep link from eventId first, fall back to eventPath/localLink
    const cloudBase = process.env.PROTECT_CLOUD_BASE_URL || '';
    const cloudLink = cloudBase && eventId
      ? `${cloudBase}/protect/events/event/${eventId}`
      : (cloudBase && eventPath ? `${cloudBase}${eventPath}` : localLink);

    // Look up camera name
    const camRow = deviceMac
      ? await pool.query('SELECT name, site FROM protect_cameras WHERE mac=$1', [deviceMac]).then(r=>r.rows[0])
      : null;
    const cameraName = camRow?.name || deviceMac || 'Unknown Camera';
    const site       = camRow?.site || alarm.name || '';

    // Detect unifi_person_id from trigger metadata
    const personId = trigger.personId || trigger.metadata?.personId
      || trigger.metadata?.face?.personId || null;

    // Thumbnail (Base64 string if "Use Thumbnails" enabled in Protect)
    const thumbnail = body.thumbnail || alarm.thumbnail || null;

    // Match to a contact
    let matchedPerson = null;
    if (personId) {
      const pRow = await pool.query(
        'SELECT id, first_name, last_name, stage FROM people WHERE unifi_person_id=$1 LIMIT 1',
        [personId]
      );
      matchedPerson = pRow.rows[0] || null;
    }

    // Store event
    await pool.query(`
      INSERT INTO security_events
        (event_id, unifi_person_id, camera_mac, camera_name, site,
         event_link, thumbnail_b64, triggered_at, alarm_name, raw_payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (event_id) DO NOTHING
    `, [
      eventId, personId, deviceMac, cameraName, site,
      cloudLink || localLink,
      thumbnail ? thumbnail.substring(0, 500000) : null, // cap at ~375KB
      new Date(typeof ts === 'number' && ts > 1e12 ? ts : ts * 1000),
      alarm.name || 'Watchlist',
      JSON.stringify(body).substring(0, 10000)
    ]).catch(e => console.warn('[Jireh] Insert event:', e.message));

    // Broadcast to all connected agents
    const alertPayload = {
      type:         'poi_detected',
      eventId,
      cameraName,
      site,
      triggeredAt:  ts,
      eventLink:    cloudLink || localLink,
      thumbnail:    thumbnail || null,
      alarmName:    alarm.name || 'Watchlist',
      person: matchedPerson ? {
        id:        matchedPerson.id,
        name:      `${matchedPerson.first_name||''} ${matchedPerson.last_name||''}`.trim(),
        stage:     matchedPerson.stage
      } : null
    };
    broadcastSecurityEvent(alertPayload);

    res.json({ ok: true, matched: !!matchedPerson });
  } catch(e) {
    console.error('[Jireh] Webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`OKCREAL Connect running on port ${PORT}`);
    console.log(`Twilio Account:  ${process.env.TWILIO_ACCOUNT_SID ? '✓' : '✗'}`);
    console.log(`Twilio API Key:  ${process.env.TWILIO_API_KEY_SID ? '✓' : '✗'}`);
    console.log(`Twilio Auth Tok: ${process.env.TWILIO_AUTH_TOKEN ? '✓' : '✗ (not needed if API Key set)'}`);
    console.log(`Twilio RecAuth:  ${twilioBasicAuth() ? '✓ ready' : '✗ NO CREDENTIALS - recordings will fail'}`);
    console.log(`Deepgram: ${process.env.DEEPGRAM_API_KEY ? '✓' : '✗'}`);
    console.log(`Grok:     ${process.env.GROK_API_KEY ? '✓' : '✗'}`);
  });
});
