/**
 * OKCREAL Connect — Backend API Server
 * Drop-in replacement for Follow Up Boss API + full CRM REST API
 * Deploy on Railway alongside the Grok debt robot
 */
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { Pool }   = require('pg');
const fs         = require('fs');
const path       = require('path');
const multer     = require('multer');
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
const {
  DATABASE_URL,
  JWT_SECRET       = 'okcreal-connect-secret-change-me',
  CRM_API_KEY      = 'crm-robot-key',   // used by the Grok robot instead of FUB key
  PORT             = 4000,
  ADMIN_EMAIL      = 'admin@okcreal.com',
  ADMIN_PASSWORD   = 'OKCReal2024!',
  ADMIN_NAME       = 'Admin',
} = process.env;
// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes('railway') || DATABASE_URL?.includes('amazonaws')
    ? { rejectUnauthorized: false }
    : false,
});
async function query(sql, params) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}
// ── Schema migration ──────────────────────────────────────────────────────────
async function runMigrations() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) { console.log('[DB] schema.sql not found — skipping migration'); return; }
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await query(sql);
  console.log('[DB] ✅ Schema applied');
  // Ensure at least one admin user exists
  const existing = await query('SELECT id FROM users WHERE email=$1', [ADMIN_EMAIL]);
  if (!existing.rows.length) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
      [ADMIN_NAME, ADMIN_EMAIL, hash, 'admin']
    );
    console.log(`[DB] ✅ Default admin created: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  }
}
// ── Auth middleware ───────────────────────────────────────────────────────────
function authRequired(req, res, next) {
  const auth = req.headers.authorization || '';
  // Support FUB-style Basic auth with CRM_API_KEY as username (for robot)
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString();
      const [user] = decoded.split(':');
      if (user === CRM_API_KEY) { req.isRobot = true; return next(); }
    } catch {}
  }
  // Support Bearer JWT (for frontend)
  if (auth.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      req.user = payload;
      return next();
    } catch {}
  }
  res.status(401).json({ error: 'Unauthorized' });
}
// ── Helpers ───────────────────────────────────────────────────────────────────
function personName(p) {
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || p.phone || 'Unknown';
}
async function getPersonTags(personId) {
  const r = await query(
    'SELECT t.name FROM tags t JOIN people_tags pt ON pt.tag_id = t.id WHERE pt.person_id = $1 ORDER BY t.name',
    [personId]
  );
  return r.rows.map(r => r.name);
}
async function getPersonCustomFields(personId) {
  const r = await query(
    'SELECT field_name, value FROM people_custom_fields WHERE person_id = $1',
    [personId]
  );
  const obj = {};
  r.rows.forEach(row => { obj[row.field_name] = row.value; });
  return obj;
}
async function getPersonPhones(personId) {
  const r = await query(
    'SELECT phone, type, is_primary FROM people_phones WHERE person_id = $1 ORDER BY is_primary DESC',
    [personId]
  );
  return r.rows;
}
// Format a person row into a FUB-compatible shape + CRM shape
async function formatPerson(p, { includeTags = true, includeCustom = false, includePhones = true } = {}) {
  const [tags, customFields, phones] = await Promise.all([
    includeTags   ? getPersonTags(p.id)            : [],
    includeCustom ? getPersonCustomFields(p.id)     : {},
    includePhones ? getPersonPhones(p.id)           : [],
  ]);
  // Merge primary phones list (FUB-style array)
  const allPhones = [];
  if (p.phone) allPhones.push({ value: p.phone, type: 'mobile' });
  phones.forEach(ph => {
    if (!allPhones.find(x => x.value === ph.phone)) allPhones.push({ value: ph.phone, type: ph.type });
  });
  return {
    id:           p.id,
    name:         personName(p),
    firstName:    p.first_name,
    lastName:     p.last_name,
    email:        p.email,
    phone:        p.phone,
    phones:       allPhones,
    stage:        p.stage,
    source:       p.source,
    assignedUserId: p.assigned_user_id,
    background:   p.background,
    tags,
    customFields,
    created:      p.created_at,
    updated:      p.updated_at,
  };
}
// =============================================================================
// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
// =============================================================================
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const r = await query('SELECT * FROM users WHERE email=$1', [email]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, avatarColor: user.avatar_color } });
  } catch(e) { console.error('[Auth]', e.message); res.status(500).json({ error: 'Server error' }); }
});
app.get('/api/auth/me', authRequired, async (req, res) => {
  if (req.isRobot) return res.json({ id: 0, name: 'Robot', role: 'robot' });
  try {
    const r = await query('SELECT id, name, email, role, avatar_color FROM users WHERE id=$1', [req.user.id]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json({ id: u.id, name: u.name, email: u.email, role: u.role, avatarColor: u.avatar_color });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// =============================================================================
// ── PEOPLE ROUTES ─────────────────────────────────────────────────────────────
// =============================================================================
app.get('/api/people', authRequired, async (req, res) => {
  const {
    search, stage, tag, assignedTo,
    limit = 50, offset = 0, sort = '-updated',
  } = req.query;
  try {
    const conditions = ['1=1'];
    const params = [];
    let idx = 1;
    let tagJoin = '';
    if (search) {
      conditions.push(`(
        p.first_name ILIKE $${idx} OR p.last_name ILIKE $${idx} OR
        p.email ILIKE $${idx} OR p.phone ILIKE $${idx} OR
        (p.first_name || ' ' || p.last_name) ILIKE $${idx}
      )`);
      params.push(`%${search}%`); idx++;
    }
    if (stage)      { conditions.push(`p.stage = $${idx}`);           params.push(stage);      idx++; }
    if (assignedTo) { conditions.push(`p.assigned_user_id = $${idx}`); params.push(assignedTo); idx++; }
    if (tag) {
      tagJoin = `JOIN people_tags pt ON pt.person_id = p.id
                 JOIN tags tg ON tg.id = pt.tag_id AND tg.name = $${idx}`;
      params.push(tag); idx++;
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const orderBy = sort === '-updated' ? 'p.updated_at DESC'
                  : sort === 'name'     ? 'p.last_name ASC, p.first_name ASC'
                  : 'p.created_at DESC';
    const countSql = `SELECT COUNT(DISTINCT p.id) AS total FROM people p ${tagJoin} ${where}`;
    const dataSql  = `
      SELECT DISTINCT p.*,
        u.name AS assigned_name,
        (SELECT COUNT(*) FROM activities a WHERE a.person_id = p.id) AS activity_count
      FROM people p
      ${tagJoin}
      LEFT JOIN users u ON u.id = p.assigned_user_id
      ${where}
      ORDER BY ${orderBy}
      LIMIT $${idx} OFFSET $${idx+1}
    `;
    const [countR, dataR] = await Promise.all([
      query(countSql, params),
      query(dataSql,  [...params, parseInt(limit), parseInt(offset)]),
    ]);
    // Fetch tags for all people in batch
    const ids = dataR.rows.map(p => p.id);
    const tagMap = {};
    if (ids.length) {
      const tR = await query(
        `SELECT pt.person_id, t.name, t.color
         FROM people_tags pt JOIN tags t ON t.id = pt.tag_id
         WHERE pt.person_id = ANY($1)`,
        [ids]
      );
      tR.rows.forEach(r => {
        if (!tagMap[r.person_id]) tagMap[r.person_id] = [];
        tagMap[r.person_id].push(r.name);
      });
    }
    const people = dataR.rows.map(p => ({
      id:           p.id,
      name:         personName(p),
      firstName:    p.first_name,
      lastName:     p.last_name,
      email:        p.email,
      phone:        p.phone,
      stage:        p.stage,
      source:       p.source,
      assignedName: p.assigned_name,
      activityCount: parseInt(p.activity_count),
      tags:         tagMap[p.id] || [],
      updated:      p.updated_at,
      created:      p.created_at,
    }));
    res.json({ people, total: parseInt(countR.rows[0].total) });
  } catch(e) { console.error('[People GET]', e.message); res.status(500).json({ error: e.message }); }
});
app.get('/api/people/:id', authRequired, async (req, res) => {
  try {
    const r = await query('SELECT * FROM people WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const person = await formatPerson(r.rows[0], { includeCustom: true });
    res.json({ person });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/people', authRequired, async (req, res) => {
  const { firstName, lastName, email, phone, stage, source, assignedUserId, background } = req.body;
  try {
    const r = await query(
      `INSERT INTO people (first_name, last_name, email, phone, stage, source, assigned_user_id, background)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [firstName, lastName, email, phone, stage || 'Lead', source, assignedUserId || null, background]
    );
    const person = await formatPerson(r.rows[0]);
    res.status(201).json({ person });
  } catch(e) { console.error('[People POST]', e.message); res.status(500).json({ error: e.message }); }
});
app.put('/api/people/:id', authRequired, async (req, res) => {
  const { firstName, lastName, email, phone, stage, source, assignedUserId, background, tags, customFields } = req.body;
  try {
    // Update core fields
    const sets = [];
    const params = [];
    let idx = 1;
    if (firstName      !== undefined) { sets.push(`first_name=$${idx++}`);        params.push(firstName); }
    if (lastName       !== undefined) { sets.push(`last_name=$${idx++}`);         params.push(lastName); }
    if (email          !== undefined) { sets.push(`email=$${idx++}`);             params.push(email); }
    if (phone          !== undefined) { sets.push(`phone=$${idx++}`);             params.push(phone); }
    if (stage          !== undefined) { sets.push(`stage=$${idx++}`);             params.push(stage); }
    if (source         !== undefined) { sets.push(`source=$${idx++}`);            params.push(source); }
    if (assignedUserId !== undefined) { sets.push(`assigned_user_id=$${idx++}`);  params.push(assignedUserId); }
    if (background     !== undefined) { sets.push(`background=$${idx++}`);        params.push(background); }
    if (sets.length) {
      params.push(req.params.id);
      await query(`UPDATE people SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${idx}`, params);
    }
    // Update tags if provided
    if (Array.isArray(tags)) {
      await query('DELETE FROM people_tags WHERE person_id=$1', [req.params.id]);
      for (const tagName of tags) {
        let tR = await query('SELECT id FROM tags WHERE name=$1', [tagName]);
        if (!tR.rows.length) {
          tR = await query('INSERT INTO tags (name) VALUES ($1) RETURNING id', [tagName]);
        }
        await query('INSERT INTO people_tags (person_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, tR.rows[0].id]);
      }
    }
    // Update custom fields if provided
    if (customFields && typeof customFields === 'object') {
      for (const [fieldName, value] of Object.entries(customFields)) {
        if (value === null || value === undefined || value === '') {
          await query('DELETE FROM people_custom_fields WHERE person_id=$1 AND field_name=$2', [req.params.id, fieldName]);
        } else {
          await query(
            `INSERT INTO people_custom_fields (person_id, field_name, value) VALUES ($1,$2,$3)
             ON CONFLICT (person_id, field_name) DO UPDATE SET value=$3`,
            [req.params.id, fieldName, String(value)]
          );
        }
      }
    }
    const updated = await query('SELECT * FROM people WHERE id=$1', [req.params.id]);
    const person = await formatPerson(updated.rows[0], { includeCustom: true });
    res.json({ person });
  } catch(e) { console.error('[People PUT]', e.message); res.status(500).json({ error: e.message }); }
});
app.delete('/api/people/:id', authRequired, async (req, res) => {
  try {
    await query('DELETE FROM people WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// =============================================================================
// ── ACTIVITIES (timeline) ─────────────────────────────────────────────────────
// =============================================================================
app.get('/api/activities', authRequired, async (req, res) => {
  const { personId, type, limit = 50, offset = 0 } = req.query;
  if (!personId) return res.status(400).json({ error: 'personId required' });
  try {
    const cond = ['a.person_id = $1'];
    const params = [personId];
    let idx = 2;
    if (type) { cond.push(`a.type = $${idx++}`); params.push(type); }
    params.push(parseInt(limit), parseInt(offset));
    const r = await query(
      `SELECT a.*, u.name AS created_by_name
       FROM activities a LEFT JOIN users u ON u.id = a.created_by
       WHERE ${cond.join(' AND ')}
       ORDER BY a.created_at DESC
       LIMIT $${idx} OFFSET $${idx+1}`,
      params
    );
    res.json({ activities: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/activities', authRequired, async (req, res) => {
  const { personId, type, body, subject, direction, duration, recordingUrl, transcript, twilioSid, fromNumber, toNumber, status } = req.body;
  if (!personId || !type) return res.status(400).json({ error: 'personId and type required' });
  try {
    const r = await query(
      `INSERT INTO activities (person_id, type, body, subject, direction, duration, recording_url, transcript, twilio_sid, from_number, to_number, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [personId, type, body, subject, direction, duration, recordingUrl, transcript, twilioSid, fromNumber, toNumber, status, req.isRobot ? null : req.user?.id]
    );
    // Update person's updated_at
    await query('UPDATE people SET updated_at=NOW() WHERE id=$1', [personId]);
    res.status(201).json({ activity: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/activities/:id', authRequired, async (req, res) => {
  const { body, status, transcript, duration } = req.body;
  try {
    const sets = []; const params = []; let idx = 1;
    if (body       !== undefined) { sets.push(`body=$${idx++}`);       params.push(body); }
    if (status     !== undefined) { sets.push(`status=$${idx++}`);     params.push(status); }
    if (transcript !== undefined) { sets.push(`transcript=$${idx++}`); params.push(transcript); }
    if (duration   !== undefined) { sets.push(`duration=$${idx++}`);   params.push(duration); }
    params.push(req.params.id);
    const r = await query(`UPDATE activities SET ${sets.join(',')} WHERE id=$${idx} RETURNING *`, params);
    res.json({ activity: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// =============================================================================
// ── TASKS ─────────────────────────────────────────────────────────────────────
// =============================================================================
app.get('/api/tasks', authRequired, async (req, res) => {
  const { personId, completed } = req.query;
  try {
    const cond = ['1=1']; const params = []; let idx = 1;
    if (personId)  { cond.push(`t.person_id=$${idx++}`);  params.push(personId); }
    if (completed !== undefined) { cond.push(`t.completed=$${idx++}`); params.push(completed === 'true'); }
    const r = await query(
      `SELECT t.*, p.first_name, p.last_name, u.name AS assigned_name
       FROM tasks t
       LEFT JOIN people p ON p.id = t.person_id
       LEFT JOIN users u ON u.id = t.assigned_to
       WHERE ${cond.join(' AND ')}
       ORDER BY t.due_date ASC NULLS LAST`,
      params
    );
    res.json({ tasks: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/tasks', authRequired, async (req, res) => {
  const { personId, title, type, note, assignedTo, dueDate } = req.body;
  try {
    const r = await query(
      `INSERT INTO tasks (person_id, title, type, note, assigned_to, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [personId || null, title, type, note, assignedTo || null, dueDate || null, req.isRobot ? null : req.user?.id]
    );
    res.status(201).json({ task: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/tasks/:id', authRequired, async (req, res) => {
  const { title, note, completed, dueDate, assignedTo } = req.body;
  try {
    const sets = []; const params = []; let idx = 1;
    if (title      !== undefined) { sets.push(`title=$${idx++}`);       params.push(title); }
    if (note       !== undefined) { sets.push(`note=$${idx++}`);        params.push(note); }
    if (completed  !== undefined) { sets.push(`completed=$${idx++}`);   params.push(completed); }
    if (dueDate    !== undefined) { sets.push(`due_date=$${idx++}`);    params.push(dueDate); }
    if (assignedTo !== undefined) { sets.push(`assigned_to=$${idx++}`); params.push(assignedTo); }
    params.push(req.params.id);
    const r = await query(`UPDATE tasks SET ${sets.join(',')} WHERE id=$${idx} RETURNING *`, params);
    res.json({ task: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// =============================================================================
// ── TAGS ──────────────────────────────────────────────────────────────────────
// =============================================================================
app.get('/api/tags', authRequired, async (req, res) => {
  try {
    const r = await query('SELECT * FROM tags ORDER BY name', []);
    res.json({ tags: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/tags', authRequired, async (req, res) => {
  const { name, color } = req.body;
  try {
    const r = await query('INSERT INTO tags (name, color) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET color=$2 RETURNING *', [name, color]);
    res.json({ tag: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// =============================================================================
// ── SMART LISTS ───────────────────────────────────────────────────────────────
// =============================================================================
app.get('/api/smart-lists', authRequired, async (req, res) => {
  try {
    const r = await query('SELECT * FROM smart_lists ORDER BY position ASC', []);
    res.json({ smartLists: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/smart-lists', authRequired, async (req, res) => {
  const { name, filters } = req.body;
  try {
    const posR = await query('SELECT COALESCE(MAX(position),0)+1 AS next FROM smart_lists', []);
    const r = await query(
      'INSERT INTO smart_lists (name, filters, position, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, JSON.stringify(filters), posR.rows[0].next, req.user?.id]
    );
    res.status(201).json({ smartList: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/smart-lists/:id', authRequired, async (req, res) => {
  try {
    await query('DELETE FROM smart_lists WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// =============================================================================
// ── CUSTOM FIELDS ─────────────────────────────────────────────────────────────
// =============================================================================
app.get('/api/custom-fields', authRequired, async (req, res) => {
  try {
    const r = await query('SELECT * FROM custom_field_definitions ORDER BY label', []);
    res.json({ customFields: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// =============================================================================
// ── USERS (team) ──────────────────────────────────────────────────────────────
// =============================================================================
app.get('/api/users', authRequired, async (req, res) => {
  try {
    const r = await query('SELECT id, name, email, role, avatar_color FROM users ORDER BY name', []);
    res.json({ users: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/users', authRequired, async (req, res) => {
  const { name, email, password, role = 'agent' } = req.body;
  const avatarColor = '#' + Math.floor(Math.random()*0xFFFFFF).toString(16).padStart(6,'0');
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await query(
      'INSERT INTO users (name, email, password_hash, role, avatar_color) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, role',
      [name, email, hash, role, avatarColor]
    );
    res.status(201).json({ user: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// =============================================================================
// ── FUB-COMPATIBLE ROUTES (for Grok debt robot — zero changes to server.js) ──
// =============================================================================
// Basic auth middleware for FUB-compatible routes
function fubAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString();
      const [user] = decoded.split(':');
      if (user === CRM_API_KEY) { req.isRobot = true; return next(); }
    } catch {}
  }
  res.status(401).json({ error: 'Unauthorized' });
}
// GET /v1/people — search by phone, tag, stage (used by robot for lookups)
app.get('/v1/people', fubAuth, async (req, res) => {
  const { phone, tag, stage, limit = 100 } = req.query;
  try {
    const conditions = ['1=1'];
    const params = [];
    let idx = 1;
    let tagJoin = '';
    if (phone) {
      const digits = phone.replace(/\\D/g, '');
      conditions.push(`(
        regexp_replace(p.phone, '[^0-9]', '', 'g') LIKE $${idx}
        OR EXISTS (
          SELECT 1 FROM people_phones pp
          WHERE pp.person_id = p.id
          AND regexp_replace(pp.phone, '[^0-9]', '', 'g') LIKE $${idx}
        )
      )`);
      params.push(`%${digits}`); idx++;
    }
    if (stage) { conditions.push(`p.stage = $${idx++}`); params.push(stage); }
    if (tag) {
      tagJoin = `JOIN people_tags pt ON pt.person_id = p.id JOIN tags tg ON tg.id = pt.tag_id AND tg.name = $${idx}`;
      params.push(tag); idx++;
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    params.push(parseInt(limit));
    const r = await query(
      `SELECT DISTINCT p.* FROM people p ${tagJoin} ${where}
       ORDER BY p.updated_at DESC LIMIT $${idx}`,
      params
    );
    const people = await Promise.all(r.rows.map(p => formatPerson(p, { includeCustom: true })));
    res.json({ people, total: people.length });
  } catch(e) { console.error('[FUB /v1/people GET]', e.message); res.status(500).json({ error: e.message }); }
});
// GET /v1/people/:id
app.get('/v1/people/:id', fubAuth, async (req, res) => {
  try {
    const r = await query('SELECT * FROM people WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const person = await formatPerson(r.rows[0], { includeCustom: true });
    res.json(person);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// PUT /v1/people/:id — update stage, tags, custom fields (robot uses this heavily)
app.put('/v1/people/:id', fubAuth, async (req, res) => {
  const { stage, tags, ...rest } = req.body;
  try {
    const sets = []; const params = []; let idx = 1;
    if (stage !== undefined) { sets.push(`stage=$${idx++}`); params.push(stage); }
    // Handle custom fields passed at root level (FUB sends them as top-level keys)
    const customFieldNames = Object.keys(rest).filter(k => k.startsWith('custom') || k.toLowerCase().includes('balance') || k.toLowerCase().includes('date'));
    for (const key of customFieldNames) {
      if (req.body[key] !== undefined) {
        const val = req.body[key];
        if (val === null || val === '') {
          await query('DELETE FROM people_custom_fields WHERE person_id=$1 AND field_name=$2', [req.params.id, key]);
        } else {
          await query(
            `INSERT INTO people_custom_fields (person_id, field_name, value) VALUES ($1,$2,$3)
             ON CONFLICT (person_id, field_name) DO UPDATE SET value=$3`,
            [req.params.id, key, String(val)]
          );
        }
      }
    }
    if (sets.length) {
      params.push(req.params.id);
      await query(`UPDATE people SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${idx}`, params);
    }
    if (Array.isArray(tags)) {
      await query('DELETE FROM people_tags WHERE person_id=$1', [req.params.id]);
      for (const tagName of tags) {
        let tR = await query('SELECT id FROM tags WHERE name=$1', [tagName]);
        if (!tR.rows.length) tR = await query('INSERT INTO tags (name) VALUES ($1) RETURNING id', [tagName]);
        await query('INSERT INTO people_tags (person_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, tR.rows[0].id]);
      }
    }
    const updated = await query('SELECT * FROM people WHERE id=$1', [req.params.id]);
    const person = await formatPerson(updated.rows[0], { includeCustom: true });
    res.json(person);
  } catch(e) { console.error('[FUB PUT /v1/people/:id]', e.message); res.status(500).json({ error: e.message }); }
});
// POST /v1/notes — robot posts call notes here
app.post('/v1/notes', fubAuth, async (req, res) => {
  const { personId, body } = req.body;
  if (!personId) return res.status(400).json({ error: 'personId required' });
  try {
    const r = await query(
      `INSERT INTO activities (person_id, type, body) VALUES ($1, 'note', $2) RETURNING *`,
      [personId, body]
    );
    await query('UPDATE people SET updated_at=NOW() WHERE id=$1', [personId]);
    res.status(201).json({ note: { id: r.rows[0].id, personId, body, created: r.rows[0].created_at } });
  } catch(e) { console.error('[FUB POST /v1/notes]', e.message); res.status(500).json({ error: e.message }); }
});
// GET /v1/notes — robot fetches prior notes for context
app.get('/v1/notes', fubAuth, async (req, res) => {
  const { personId, limit = 10 } = req.query;
  if (!personId) return res.status(400).json({ error: 'personId required' });
  try {
    const r = await query(
      `SELECT * FROM activities WHERE person_id = $1 AND type = 'note'
       ORDER BY created_at DESC LIMIT $2`,
      [personId, parseInt(limit)]
    );
    const notes = r.rows.map(row => ({
      id:        row.id,
      personId:  row.person_id,
      body:      row.body,
      created:   row.created_at,
      createdByName: 'Grok AI',
    }));
    res.json({ notes, total: notes.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// POST /v1/tasks — robot creates escalation tasks
app.post('/v1/tasks', fubAuth, async (req, res) => {
  const { personId, note, assignedUserId, dueDate, isCompleted = false } = req.body;
  try {
    const r = await query(
      `INSERT INTO tasks (person_id, title, note, assigned_to, due_date, completed)
       VALUES ($1, 'Escalate to Management', $2, $3, $4, $5) RETURNING *`,
      [personId || null, note, assignedUserId || null, dueDate || null, isCompleted]
    );
    res.status(201).json({ task: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// GET /v1/customfields — robot fetches field names on startup
app.get('/v1/customfields', fubAuth, async (req, res) => {
  try {
    const r = await query('SELECT * FROM custom_field_definitions ORDER BY label', []);
    const customFields = r.rows.map(f => ({ id: f.id, label: f.label, name: f.name, type: f.type }));
    res.json({ customFields, total: customFields.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// GET /v1/emails — robot calls this, return empty (no email system yet)
app.get('/v1/emails', fubAuth, async (req, res) => {
  res.json({ emails: [], total: 0 });
});
// =============================================================================
// ── HEALTH + STATIC ───────────────────────────────────────────────────────────
// =============================================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'OKCREAL Connect', ts: new Date().toISOString() });
});
// Serve React frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.status(404).send('Frontend not built yet');
});
// =============================================================================
// ── START ─────────────────────────────────────────────────────────────────────
// =============================================================================
async function start() {
  try {
    await runMigrations();
    const server = app.listen(PORT, () => {
      console.log(`\\n⚡ OKCREAL Connect running on port ${PORT}`
