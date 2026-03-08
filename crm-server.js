require('dotenv').config();
const express = require('express');
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

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));
// Serve Twilio Voice SDK from node_modules
app.get('/twilio-voice.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/@twilio/voice-sdk/dist/twilio.min.js'));
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
    const { search, stage, limit = 50, offset = 0 } = req.query;
    let where = ['1=1']; let params = [];
    if (search) {
      params.push(`%${search}%`);
      where.push(`(p.first_name ILIKE $${params.length} OR p.last_name ILIKE $${params.length} OR p.phone ILIKE $${params.length} OR p.email ILIKE $${params.length})`);
    }
    if (stage) { params.push(stage); where.push(`p.stage=$${params.length}`); }
    const countR = await pool.query(`SELECT COUNT(*) FROM people p WHERE ${where.join(' AND ')}`, params);
    params.push(limit, offset);
    const r = await pool.query(
      `SELECT p.* FROM people p WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    res.json({ people: r.rows, total: parseInt(countR.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/people/:id', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM people WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/people', auth, async (req, res) => {
  try {
    const { firstName, lastName, phone, email, stage, source, background, tags, customFields, assignedTo, address, city, state, zip } = req.body;
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

app.put('/api/people/:id', auth, async (req, res) => {
  try {
    const { firstName, lastName, phone, email, stage, source, background, tags, customFields, assignedTo, address, city, state, zip } = req.body;
    const r = await pool.query(
      `UPDATE people SET
        first_name=COALESCE($1,first_name), last_name=COALESCE($2,last_name),
        phone=COALESCE($3,phone), email=COALESCE($4,email),
        stage=COALESCE($5,stage), source=COALESCE($6,source),
        background=COALESCE($7,background), tags=COALESCE($8,tags),
        custom_fields=custom_fields||COALESCE($9,'{}'),
        address=COALESCE($10,address), city=COALESCE($11,city),
        state=COALESCE($12,state), zip=COALESCE($13,zip),
        updated_at=NOW()
       WHERE id=$14 RETURNING *`,
      [firstName||null, lastName||null, phone||null, email||null, stage||null,
       source||null, background||null, tags||null,
       customFields ? JSON.stringify(customFields) : '{}',
       address||null, city||null, state||null, zip||null, req.params.id]
    );
    res.json(r.rows[0]);
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
app.get('/api/people/:id/household-activities', auth, async (req, res) => {
  try {
    const memberIds = [req.params.id];
    const rels = await pool.query(`
      SELECT CASE WHEN person_id_a=$1 THEN person_id_b ELSE person_id_a END AS related_id
      FROM person_relationships WHERE person_id_a=$1 OR person_id_b=$1
    `, [req.params.id]);
    rels.rows.forEach(r => memberIds.push(r.related_id));
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
app.get('/api/activities', auth, async (req, res) => {
  try {
    const { personId, limit = 50, type } = req.query;
    let where = ['1=1']; let params = [];
    if (personId) { params.push(personId); where.push(`a.person_id=$${params.length}`); }
    if (type) { params.push(type); where.push(`a.type=$${params.length}`); }
    params.push(limit);
    const r = await pool.query(
      `SELECT a.*, ag.name as agent_name
       FROM activities a
       LEFT JOIN agents ag ON ag.id::text=a.agent_id::text
       WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT $${params.length}`,
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
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  return require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
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
    const personR = await pool.query('SELECT * FROM people WHERE phone ILIKE $1 LIMIT 1', [fromNum]);
    const person = personR.rows[0];
    const callInsert = await pool.query(
      'INSERT INTO calls (twilio_call_sid,person_id,line_id,direction,status,from_number,to_number) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [callSid, person?.id||null, line?.id||null, 'inbound', 'ringing', fromNum, toNum]
    );
    let agents = [];
    if (line) {
      const aR = await pool.query('SELECT a.* FROM agents a JOIN line_agents la ON la.agent_id::text=a.id::text WHERE la.line_id=$1 AND a.is_active=true', [line.id]);
      agents = aR.rows;
    }
    // Fallback: ring ALL active agents if none assigned to this line
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
          'INSERT INTO activities (person_id,agent_id,call_id,type,body,duration) VALUES($1,$2,$3,$4,$5,$6)',
          [call.person_id, call.agent_id, call.id, 'call', 'Transcript processing...', call.duration_seconds]
        ).catch(() => {});
      }
    }
    res.sendStatus(200);
  } catch (e) { console.error(e); res.sendStatus(200); }
});

app.post('/api/twilio/recording', async (req, res) => {
  res.sendStatus(200);
  try {
    const { CallSid, RecordingUrl } = req.body;
    const callR = await pool.query('SELECT * FROM calls WHERE twilio_call_sid=$1', [CallSid]);
    const call = callR.rows[0];
    if (!call) return;
    await pool.query('UPDATE calls SET recording_url=$1 WHERE id=$2', [`${RecordingUrl}.mp3`, call.id]);
    let transcript = '', summary = '';
    const dg = initDeepgram();
    if (dg) {
      try {
        // Twilio recording URLs require Basic Auth — embed credentials so Deepgram can fetch them
        const rawUrl = `${RecordingUrl}.mp3`;
        const authedUrl = rawUrl.replace(
          'https://',
          `https://${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}@`
        );
        const { result } = await dg.listen.prerecorded.transcribeUrl(
          { url: authedUrl },
          { model: 'nova-2', smart_format: true, diarize: true, punctuate: true, utterances: true }
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
      } catch (e) { console.error('Deepgram error:', e.message); }
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
    await pool.query('UPDATE activities SET body=$1 WHERE call_id=$2', [activityBody, call.id]).catch(() => {});
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
          const authedUrl = call.recording_url.replace('https://', `https://${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}@`);
          const { result } = await dg.listen.prerecorded.transcribeUrl(
            { url: authedUrl },
            { model: 'nova-2', smart_format: true, diarize: true, punctuate: true, utterances: true }
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
        } catch(e) { console.error('Retry Deepgram error:', e.message); }
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
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS address TEXT`, 'people.address');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS city TEXT`, 'people.city');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS state TEXT`, 'people.state');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS zip TEXT`, 'people.zip');

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
    await pool.query(`
      DELETE FROM call_lines WHERE id NOT IN (
        SELECT MIN(id::text)::uuid FROM call_lines GROUP BY twilio_number
      )
    `).catch(() => {});
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

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`OKCREAL Connect running on port ${PORT}`);
    console.log(`Twilio:   ${process.env.TWILIO_ACCOUNT_SID ? '✓' : '✗'}`);
    console.log(`Deepgram: ${process.env.DEEPGRAM_API_KEY ? '✓' : '✗'}`);
    console.log(`Grok:     ${process.env.GROK_API_KEY ? '✓' : '✗'}`);
  });
});
