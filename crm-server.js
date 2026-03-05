require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

// DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));

// Auth middleware
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
      where.push(`(first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR phone ILIKE $${params.length} OR email ILIKE $${params.length})`);
    }
    if (stage) { params.push(stage); where.push(`stage=$${params.length}`); }
    const countR = await pool.query(`SELECT COUNT(*) FROM people WHERE ${where.join(' AND ')}`, params);
    params.push(limit, offset);
    const r = await pool.query(
      `SELECT p.*, a.name as assigned_name FROM people p LEFT JOIN agents a ON a.id=p.assigned_to WHERE ${where.join(' AND ')} ORDER BY p.updated_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    res.json({ people: r.rows, total: parseInt(countR.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/people/:id', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT p.*, a.name as assigned_name FROM people p LEFT JOIN agents a ON a.id=p.assigned_to WHERE p.id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/people', auth, async (req, res) => {
  try {
    const { firstName, lastName, phone, email, stage, source, background, tags, customFields, assignedTo } = req.body;
    const r = await pool.query(
      'INSERT INTO people (first_name,last_name,phone,email,stage,source,background,tags,custom_fields,assigned_to) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [firstName, lastName, phone, email, stage||'lead', source, background, tags||[], JSON.stringify(customFields||{}), assignedTo||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/people/:id', auth, async (req, res) => {
  try {
    const { firstName, lastName, phone, email, stage, source, background, tags, customFields, assignedTo } = req.body;
    const r = await pool.query(
      'UPDATE people SET first_name=$1,last_name=$2,phone=$3,email=$4,stage=$5,source=$6,background=$7,tags=$8,custom_fields=custom_fields||$9,assigned_to=$10,updated_at=NOW() WHERE id=$11 RETURNING *',
      [firstName, lastName, phone, email, stage, source, background, tags, JSON.stringify(customFields||{}), assignedTo||null, req.params.id]
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

// ─── ACTIVITIES ───────────────────────────────────────────────────────────────
app.get('/api/activities', auth, async (req, res) => {
  try {
    const { personId, limit = 50, type } = req.query;
    let where = ['1=1']; let params = [];
    if (personId) { params.push(personId); where.push(`a.person_id=$${params.length}`); }
    if (type) { params.push(type); where.push(`a.type=$${params.length}`); }
    params.push(limit);
    const r = await pool.query(
      `SELECT a.*, ag.name as agent_name, c.transcript, c.summary, c.direction, c.duration_seconds, c.recording_url as call_recording_url,
       cl.name as line_name FROM activities a
       LEFT JOIN agents ag ON ag.id=a.agent_id
       LEFT JOIN calls c ON c.id=a.call_id
       LEFT JOIN call_lines cl ON cl.id=c.line_id
       WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/activities', auth, async (req, res) => {
  try {
    const { personId, type, body, duration, recordingUrl, callId } = req.body;
    const r = await pool.query(
      'INSERT INTO activities (person_id,agent_id,type,body,duration,recording_url,call_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [personId, req.agent.id, type, body, duration, recordingUrl, callId||null]
    );
    await pool.query('UPDATE people SET updated_at=NOW() WHERE id=$1', [personId]);
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
      `SELECT t.*, p.first_name||' '||COALESCE(p.last_name,'') as person_name, a.name as agent_name
       FROM tasks t LEFT JOIN people p ON p.id=t.person_id LEFT JOIN agents a ON a.id=t.agent_id
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
      [personId, req.agent.id, title, note, dueDate||null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tasks/:id', auth, async (req, res) => {
  try {
    const { title, note, dueDate, completed, assignedTo } = req.body;
    const completedAt = completed ? 'NOW()' : 'NULL';
    const r = await pool.query(
      `UPDATE tasks SET title=$1,note=$2,due_date=$3,completed=$4,completed_at=${completedAt},agent_id=$5 WHERE id=$6 RETURNING *`,
      [title, note, dueDate||null, completed||false, assignedTo||req.agent.id, req.params.id]
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

// ─── TWILIO ───────────────────────────────────────────────────────────────────
const initTwilio = () => {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_API_KEY_SID) return null;
  return require('twilio')(process.env.TWILIO_API_KEY_SID, process.env.TWILIO_API_KEY_SECRET, {
    accountSid: process.env.TWILIO_ACCOUNT_SID
  });
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

// Twilio token for browser SDK
app.get('/api/twilio/token', auth, async (req, res) => {
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
});

// Get call lines
app.get('/api/twilio/lines', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM call_lines WHERE is_active=true ORDER BY name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Outbound call TwiML
app.post('/api/twilio/voice', async (req, res) => {
  try {
    const twiml = require('twilio').twiml;
    const VoiceResponse = twiml.VoiceResponse;
    const response = new VoiceResponse();
    const { To, CallerId, personId, lineId, agentId } = req.body;
    if (!To) { response.say('No destination number provided.'); return res.type('xml').send(response.toString()); }
    const dial = response.dial({ callerId: CallerId || process.env.TWILIO_RESIDENT_NUMBER, record: 'record-from-ringing-dual', recordingStatusCallback: `${process.env.APP_URL}/api/twilio/recording` });
    dial.number({ statusCallbackEvent: 'completed', statusCallback: `${process.env.APP_URL}/api/twilio/status` }, To);
    // Log call
    if (personId && agentId) {
      await pool.query(
        'INSERT INTO calls (twilio_call_sid, person_id, agent_id, line_id, direction, status, from_number, to_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
        [req.body.CallSid, personId, agentId, lineId||null, 'outbound', 'initiated', CallerId||process.env.TWILIO_RESIDENT_NUMBER, To]
      ).catch(() => {});
    }
    res.type('xml').send(response.toString());
  } catch (e) { console.error(e); res.status(500).send('<Response><Say>Error</Say></Response>'); }
});

// Inbound call
app.post('/api/twilio/inbound', async (req, res) => {
  try {
    const twiml = require('twilio').twiml.VoiceResponse;
    const response = new twiml();
    const toNum = req.body.To;
    const fromNum = req.body.From;
    const callSid = req.body.CallSid;
    // Find line
    const lineR = await pool.query('SELECT * FROM call_lines WHERE twilio_number=$1', [toNum]);
    const line = lineR.rows[0];
    // Find person
    const personR = await pool.query("SELECT * FROM people WHERE phone ILIKE $1 LIMIT 1", [fromNum]);
    const person = personR.rows[0];
    // Create call record
    const callInsert = await pool.query(
      'INSERT INTO calls (twilio_call_sid, person_id, line_id, direction, status, from_number, to_number) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [callSid, person?.id||null, line?.id||null, 'inbound', 'ringing', fromNum, toNum]
    );
    // Get assigned agents
    let agents = [];
    if (line) {
      const aR = await pool.query('SELECT a.* FROM agents a JOIN line_agents la ON la.agent_id=a.id WHERE la.line_id=$1 AND a.is_active=true', [line.id]);
      agents = aR.rows;
    }
    if (agents.length === 0) {
      // Voicemail
      response.say('You have reached OKCREAL. Please leave a message after the beep.');
      response.record({ maxLength: 120, recordingStatusCallback: `${process.env.APP_URL}/api/twilio/voicemail?callId=${callInsert.rows[0].id}` });
    } else {
      const dial = response.dial({ record: 'record-from-ringing-dual', recordingStatusCallback: `${process.env.APP_URL}/api/twilio/recording` });
      agents.forEach(a => dial.client(a.id));
    }
    res.type('xml').send(response.toString());
  } catch (e) { console.error(e); res.status(500).send('<Response><Say>Error connecting</Say></Response>'); }
});

// Call status callback
app.post('/api/twilio/status', async (req, res) => {
  try {
    const { CallSid, CallStatus, CallDuration } = req.body;
    if (['completed', 'failed', 'busy', 'no-answer'].includes(CallStatus)) {
      const r = await pool.query(
        'UPDATE calls SET status=$1, duration_seconds=$2, ended_at=NOW() WHERE twilio_call_sid=$3 RETURNING *',
        [CallStatus, parseInt(CallDuration)||0, CallSid]
      );
      const call = r.rows[0];
      if (call) {
        await pool.query(
          'INSERT INTO activities (person_id, agent_id, call_id, type, body, duration) VALUES($1,$2,$3,$4,$5,$6)',
          [call.person_id, call.agent_id, call.id, 'call', 'Transcript processing...', call.duration_seconds]
        ).catch(() => {});
      }
    }
    res.sendStatus(200);
  } catch (e) { console.error(e); res.sendStatus(200); }
});

// Recording ready - transcribe + summarize
app.post('/api/twilio/recording', async (req, res) => {
  res.sendStatus(200); // Respond immediately
  try {
    const { CallSid, RecordingUrl, RecordingDuration } = req.body;
    const callR = await pool.query('SELECT * FROM calls WHERE twilio_call_sid=$1', [CallSid]);
    const call = callR.rows[0];
    if (!call) return;
    await pool.query('UPDATE calls SET recording_url=$1 WHERE id=$2', [`${RecordingUrl}.mp3`, call.id]);
    // Transcribe
    let transcript = '';
    let summary = '';
    const dg = initDeepgram();
    if (dg) {
      try {
        const { result } = await dg.listen.prerecorded.transcribeUrl(
          { url: `${RecordingUrl}.mp3` },
          { model: 'nova-2', smart_format: true, diarize: true, punctuate: true, utterances: true }
        );
        const utterances = result?.results?.utterances;
        if (utterances?.length) {
          transcript = utterances.map(u => {
            const ts = `[${Math.floor(u.start/60)}:${String(Math.floor(u.start%60)).padStart(2,'0')}]`;
            const speaker = u.channel === 0 ? 'Agent' : 'Caller';
            return `${ts} ${speaker}: ${u.transcript}`;
          }).join('\n');
        } else {
          transcript = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
        }
      } catch (e) { console.error('Deepgram error:', e.message); }
    }
    // Summarize
    const grok = initGrok();
    if (grok && transcript && transcript.length > 20) {
      try {
        const personR = call.person_id ? await pool.query('SELECT first_name, last_name FROM people WHERE id=$1', [call.person_id]) : null;
        const agentR = call.agent_id ? await pool.query('SELECT name FROM agents WHERE id=$1', [call.agent_id]) : null;
        const contactName = personR?.rows[0] ? `${personR.rows[0].first_name} ${personR.rows[0].last_name||''}`.trim() : 'Unknown';
        const agentName = agentR?.rows[0]?.name || 'Agent';
        const completion = await grok.chat.completions.create({
          model: 'grok-3',
          max_tokens: 200,
          messages: [{
            role: 'system',
            content: 'You summarize property management calls in 2-3 sentences. Focus on: payment commitments, maintenance issues, lease inquiries, delinquency resolutions, action items.'
          }, {
            role: 'user',
            content: `${call.direction === 'inbound' ? 'Inbound' : 'Outbound'} call. Agent: ${agentName}. Contact: ${contactName}.\n\nTranscript:\n${transcript}`
          }]
        });
        summary = completion.choices[0]?.message?.content || '';
      } catch (e) { console.error('Grok error:', e.message); }
    }
    // Save
    await pool.query('UPDATE calls SET transcript=$1, summary=$2 WHERE id=$3', [transcript, summary, call.id]);
    // Update activity
    if (summary || transcript) {
      await pool.query(
        'UPDATE activities SET body=$1 WHERE call_id=$2',
        [summary || transcript.substring(0, 200), call.id]
      );
    }
  } catch (e) { console.error('Recording webhook error:', e.message); }
});

// Voicemail
app.post('/api/twilio/voicemail', async (req, res) => {
  res.sendStatus(200);
  try {
    const { callId } = req.query;
    const { RecordingUrl } = req.body;
    if (!callId) return;
    await pool.query('UPDATE calls SET status=$1, recording_url=$2 WHERE id=$3', ['voicemail', `${RecordingUrl}.mp3`, callId]);
    const callR = await pool.query('SELECT * FROM calls WHERE id=$1', [callId]);
    const call = callR.rows[0];
    if (call) {
      await pool.query(
        'INSERT INTO activities (person_id, call_id, type, body, recording_url) VALUES($1,$2,$3,$4,$5)',
        [call.person_id, call.id, 'voicemail', 'Voicemail received', `${RecordingUrl}.mp3`]
      ).catch(() => {});
    }
  } catch (e) { console.error('Voicemail error:', e.message); }
});

// ─── ADMIN ────────────────────────────────────────────────────────────────────
app.get('/api/admin/agents', auth, adminOnly, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,name,email,role,phone,avatar_color,is_active,created_at FROM agents ORDER BY name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/agents', auth, adminOnly, async (req, res) => {
  try {
    const { name, email, password, role, phone, avatarColor } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO agents (name,email,password_hash,role,phone,avatar_color) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,email,role,phone,avatar_color,is_active',
      [name, email, hash, role||'agent', phone, avatarColor||'#6366f1']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/agents/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, email, role, phone, isActive, avatarColor, password } = req.body;
    let hash = undefined;
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
      SELECT cl.*, COALESCE(json_agg(json_build_object('id',a.id,'name',a.name)) FILTER (WHERE a.id IS NOT NULL), '[]') as agents
      FROM call_lines cl LEFT JOIN line_agents la ON la.line_id=cl.id LEFT JOIN agents a ON a.id=la.agent_id
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
    const calls = await pool.query("SELECT direction, COUNT(*) FROM calls WHERE started_at > NOW()-INTERVAL '30 days' GROUP BY direction");
    const tasks = await pool.query('SELECT COUNT(*) FROM tasks WHERE completed=false');
    res.json({ stages: stages.rows, calls: calls.rows, openTasks: tasks.rows[0].count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Start
// ─── AUTO MIGRATION ───────────────────────────────────────────────────────────
async function initDB() {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    // Drop old conflicting tables (old schema) in dependency order
    await pool.query(`DROP TABLE IF EXISTS line_agents CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS activities CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS tasks CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS calls CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS call_lines CASCADE`);
    // Create all tables fresh
    await pool.query(`CREATE TABLE IF NOT EXISTS agents (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT DEFAULT 'agent', phone TEXT, avatar_color TEXT DEFAULT '#6366f1', is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS people (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), first_name TEXT NOT NULL, last_name TEXT, phone TEXT, email TEXT, stage TEXT DEFAULT 'lead', source TEXT, background TEXT, tags TEXT[] DEFAULT '{}', custom_fields JSONB DEFAULT '{}', assigned_to UUID REFERENCES agents(id), created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS call_lines (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name TEXT NOT NULL, twilio_number TEXT NOT NULL, description TEXT, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS line_agents (line_id UUID REFERENCES call_lines(id) ON DELETE CASCADE, agent_id UUID REFERENCES agents(id) ON DELETE CASCADE, PRIMARY KEY (line_id, agent_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS calls (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), twilio_call_sid TEXT UNIQUE, person_id UUID REFERENCES people(id), agent_id UUID REFERENCES agents(id), line_id UUID REFERENCES call_lines(id), direction TEXT, status TEXT, duration_seconds INTEGER, from_number TEXT, to_number TEXT, recording_url TEXT, recording_sid TEXT, transcript TEXT, summary TEXT, started_at TIMESTAMPTZ DEFAULT NOW(), ended_at TIMESTAMPTZ)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS activities (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), person_id UUID REFERENCES people(id) ON DELETE CASCADE, agent_id UUID REFERENCES agents(id), call_id UUID REFERENCES calls(id), type TEXT NOT NULL, body TEXT, duration INTEGER, recording_url TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tasks (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), person_id UUID REFERENCES people(id) ON DELETE CASCADE, agent_id UUID REFERENCES agents(id), title TEXT NOT NULL, note TEXT, due_date DATE, completed BOOLEAN DEFAULT false, completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS smart_lists (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name TEXT NOT NULL, filters JSONB DEFAULT '{}', sort_order INTEGER DEFAULT 0)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS custom_fields (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), key TEXT UNIQUE NOT NULL, label TEXT NOT NULL, field_type TEXT DEFAULT 'text', options TEXT[], sort_order INTEGER DEFAULT 0)`);
    // Seed admin user (password: OKCreal2026!)
    const adminHash = await bcrypt.hash('OKCreal2026!', 10);
    await pool.query(`INSERT INTO agents (name,email,password_hash,role) VALUES ('Admin','admin@okcreal.com',$1,'admin') ON CONFLICT (email) DO UPDATE SET password_hash=$1`, [adminHash]);
    await pool.query(`INSERT INTO smart_lists (name,filters,sort_order) VALUES ('Delinquent Residents','{}',0),('Active Residents','{}',1),('Active Leads','{}',2),('Past Clients','{}',3) ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO custom_fields (key,label,field_type,sort_order) VALUES ('past_due_balance','Past Due Balance','number',0),('payment_commitment_date','Payment Commitment Date','date',1),('unit_number','Unit Number','text',2),('lease_end_date','Lease End Date','date',3) ON CONFLICT (key) DO NOTHING`);
    await pool.query(`INSERT INTO call_lines (name,twilio_number,description) VALUES ('OKCREAL Connect Line','+14052562614','Main OKCREAL line') ON CONFLICT DO NOTHING`);
    console.log('✅ DB schema initialized');
  } catch(e) { console.error('DB init error:', e.message); }
}

initDB().then(() => app.listen(PORT, () => {
  console.log(`OKCREAL Connect running on port ${PORT}`);
  console.log(`Twilio: ${process.env.TWILIO_ACCOUNT_SID ? '✓' : '✗'}`);
  console.log(`Deepgram: ${process.env.DEEPGRAM_API_KEY ? '✓' : '✗'}`);
  console.log(`Grok: ${process.env.GROK_API_KEY ? '✓' : '✗'}`);
}));
