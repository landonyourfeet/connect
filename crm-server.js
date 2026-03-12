require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const { google } = require('googleapis');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

// ── DATABASE_URL guard — crash loudly rather than silently lose data ──
if (!process.env.DATABASE_URL) {
  console.error('❌ FATAL: DATABASE_URL is not set. Refusing to start without a database.');
  console.error('   Set DATABASE_URL in Railway environment variables to your Postgres connection string.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // Keep connections alive across Railway's load balancer
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10,
});

// Log pool errors — prevents silent crashes from dropped DB connections
pool.on('error', (err) => {
  console.error('[DB Pool] Unexpected error on idle client:', err.message);
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

// ── Per-agent SSE (presence + notifications) ─────────────────────────────
const agentConnections = new Map(); // agentId -> res

function sendToAgent(agentId, payload) {
  const res = agentConnections.get(String(agentId));
  if (!res) return false;
  try { res.write(`data: ${JSON.stringify(payload)}\n\n`); return true; }
  catch(e) { agentConnections.delete(String(agentId)); return false; }
}

function broadcastToAll(payload, excludeAgentId = null) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const [agentId, res] of agentConnections) {
    if (excludeAgentId && String(agentId) === String(excludeAgentId)) continue;
    try { res.write(data); } catch(e) { agentConnections.delete(agentId); }
  }
}

// ── Presence tracking ─────────────────────────────────────────────────────
const presenceMap = new Map(); // personId -> Map(agentId -> agentInfo)

function setPresence(personId, agent) {
  if (!presenceMap.has(String(personId))) presenceMap.set(String(personId), new Map());
  presenceMap.get(String(personId)).set(String(agent.id), {
    id: agent.id, name: agent.name,
    avatar_b64: agent.avatar_b64 || null,
    avatar_color: agent.avatar_color || '#6366f1'
  });
  broadcastPresence(personId);
}

function clearPresence(personId, agentId) {
  const map = presenceMap.get(String(personId));
  if (map) { map.delete(String(agentId)); if (!map.size) presenceMap.delete(String(personId)); }
  broadcastPresence(personId);
}

function broadcastPresence(personId) {
  const map = presenceMap.get(String(personId));
  const viewers = map ? Array.from(map.values()) : [];
  broadcastToAll({ type: 'presence', personId: String(personId), viewers });
}

// Gmail OAuth helper
function getGmailOAuth(agent) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.APP_URL + '/api/gmail/callback'
  );
  if (agent.gmail_refresh_token) {
    oauth2.setCredentials({ refresh_token: agent.gmail_refresh_token });
  }
  return oauth2;
}

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));
// Serve Twilio Voice SDK from node_modules
app.get('/twilio-voice.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/@twilio/voice-sdk/dist/twilio.min.js'));
});

// ── FAVICON ──
const _pngBuf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAGTElEQVR42u2be0xTVxzHv7elQOmDosizlCFugIOY8SrTqcNsZGoiL5Mlw01jMEyNbiqQaXDiQBBFrIAIMoQWblhkky3TLEtkKrg5UAvqMJkuaHQ1A3m0BIu82v3hiI97Wm7R/UPv78/f755z7vdz7u/87jm3pWDFXFxczZgBZjQaKEsxaiYLZwOCZy/iLWnj2Yt4Sxp59iSepJVnb+JfhMCDnRtlj7NvtQpwADgAHAAOAAeAA8AB4ABwADgAHAC7MAe2F0okEsTFvQelMhqhoW/Czc0NMpkrRkZGoNfrodM9QGvrZTQ3t6Cj4xqrPpXKaNC0muHftWs3Tp78ltjG29sLNK2GQqFgxNTqWuTk5LEWHyWSTA1AKHTGpk2fYs2ajyCRSBhxgUAAsVgMuVwOpTIaW7duxtWrWhQWHsbly1de6Wz5+vqAptWQy+WMWHW1Bvv25bPqZ7lsFjZ7+iLY2cV6CigUCjQ0fIONG9OI4i1ZREQ46upqkJaW+srEy+W+oGkNUXxVVTUr8UIeD4WKQJT4v45gZxfrKeDuPhs0rYa3t9e0bpjP5yMjYwcoiofy8uMvJd7Pzw80rYaPjzcjVllZhYKCwin7EFAUvg4IglIsZbcIlpSoiOKNRiOKio4gLm4F5s9fgMjIGKSmpqG1tY3Yz/btn2Hhwphpi/f3V6C+XkMUX15eyUo8AHwlD2CItwhg2bJYREVFMvwDAwNITv4QZWXl6Oq6g9HRUej1Bpw/34yUlLWg6XrmADweMjJ2TEt8QMBrqK+vhZcXcyLKyspRWFjEqp9QoQirZ81hXwY3bFhPvHjv3lzcvv2XxYFycvKI8bCwUMTEKG0SHxg4FzStgYeHByNWWnoMRUVHWPe1xcuX+AWI7u1mAhCJRAgPf4txsU73AGfO/GR1oPHxcZw4UUOMLV78DusbnjcvEHV1anh4MGetuPgoVKpi1n05UTwsErsyU9k0gUP/3GcughER4eDz+YwGzc0tMJunPj+9cKGZ6I+OjmR90+vXryP6VapilJYes+lJCheJ4cxjPujnBvUYnJhgPgGenh7Ejm7dus1qwJ6eh9DrDQw/KY9tsUOHVDaLBwAfRyei/5rxEXkNcHOTERsMDg6yHtRgYAKw1C8bu3HjD1RUVE6r7SwHcqXvGx8jA6Ao8pdkNo//0z5I7ac/+2FhocjLywGPZ/vWhbJ1M9TfP0C8UCqVsh5UKmUuOnq9/qVSYPXqpGlB6BsfJ/pnOwjIALq7e4gNgoLeYDXgnDnukMmYALq7u1nfdHt7h0UI+fm5NkF4MDpC9C9wEZEBaLXtmJiYYDRYsmSxxfR41t59dynR39bGfmPU0PCdxXf75ORE7N+/jzUE7aMhPDaZGP5YqQxSPp8JYGhoCFptB3Entnz5B1O+/69b9wkx1tJy0aZHt7pag9xcMoSkpATWEEbMJvw6xFyUXXh8bPPyI78JVlVVEzvLzs5CYOBci4NlZe0kpkpn501cuvS7zXlfU6OxuL9PSkpAQUEeKwil3Tqi/2N3T/AFAufsFwN37tzFokVvMzYgQqEQiYnxACj09vbCaByGWCyCUhmN3Ny9WLlyBbF6ZGbuxL1794lb3OTkRIa/qekcOjtvPqnX165Drzdg6dIljOtCQoIhl8vR1PSL1SrVMzYGH0cnzBeK2J0Imc1mbNnyORobG+Dp6flcTCwWIz19G9LTt7GaRZWqBBcv/vZSFUCjqYPZbMaePVmMWGJiPCiKQmbmTpgIuT5pX/59F/5OzogSSdhth3t6HiIlZa3VzY81M5lMOHy4GEePHsOrsNpaGtnZOcRYQsIqHDiQbzUdRs0mpHb9iR/1fc+vW6QUeFq7DTh16nvw+XyEhATB0dGRdRnLyPgCjY0/THnKM1UKPGvXr99AX18/YmOZlSY4OAgKhR/OnrWcDmNmM3429KNr5DHmOgsx20Ew9Zng8PAwDh48hIqK44iLex8xMcr/DkVlcHWdPBQ1QKfToa3tCpqbW6DVtv9vp7iTZw7Z2bsZZTk+fhWAJ+lAKuWTdlrfh9P6PijFUu4nMtyHEQ4AB4ADwAHgAHAAOAAcAA4AB4ADwAGwSwDW/lQ4081oNFDcEzBJwh5n/7k1wJ4gPKuVZylgD+KJVWAmQyBpsyrWHv4+/y+rixtpEyjeTQAAAABJRU5ErkJggg==', 'base64');
const _icoBuf = Buffer.from('AAABAAIAEBAAAAAAIAC6AgAAJgAAACAgAAAAACAAOAYAAOACAACJUE5HDQoaCgAAAA1JSERSAAAAEAAAABAIBgAAAB/z/2EAAAKBSURBVHiclZPJa1RrEMV/9d0b0/eapDsaSFDbAaeIuhBbUHECBREnnBa6EUJciRvBf0F8byEaEQeCoAtBBIkLQ+JCSHCjKPbCAfQfCKRxuG23Se5wXHQM77lwqN1XdU5VUd85FgRz55nFd8G2AwKMX8c0RiNS0wkLw/wI2DZQBrjfkH9EBuZAoxaGeTUSOLPGcEkzSDObef9UzwDnAJmZc84RxwlJkuB53gwxjmMk4ZwjTVMmJycbzcB5mJyZWRzHfP0a0d6ep7W1lWr1M2ma4nke7e1zCIKAWq1GLtdMsbgAMyOWqKaJuSRJKBTy3Llzm+HhRzx5MkxfXx9mGYVCgefPn7J+/Tq6u1dQLr/g4IH9THyrUfCbuLJ4OYDp6tVrGhsb0+rVa7Vp01bV63WdPXtOHR2dGh8f1/nz/+jt23e6cOFfgRO5Fl1euU7Rlj2iublF5XJZFy9e0vQXaWDgoQYHBzV/flHv33+QJPX33xKgtrYOzQrzelXaoZurSnJJMkUURSxbtnTm8osWLaRS+Ugcx/i+x9DQMLt27eTw4aNEUYVM8ClJ6A4CMPN16NBRRdEX9fff0r1791WpjKtU2qiurqIk6ciRYzp9+owk6VRPrzy/WQfmLVFl827Z7NkF1et1NmwosW/fXuJ4igcPBnjz5jWdnV309vYwNPSYly+fcfJkD8VikRvXb1CJqqxpacXCMC/nHLVaDWkKAM/LEQQBSZIwMVGlqSkkl8tRrX4CRBC04ZnjW5ZiYZjPAHPO4VxDyVmWkWUZAL7vk6YpkvA8D4A0TaGhe/1Pyn/og//4oSHl0YYxyP6ObA4YdZJ/HLKR6Q30GyLTGAfZiOQf/w5e7zNy2z/8sAAAAABJRU5ErkJggolQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgGAAAAc3p69AAABf9JREFUeJzFl12MVPUZxn////mYjzNnZoelCRZUbLFtYM26QGNtZdWmRiCSmvSiifeaeoc0TRS90FIosdgmjbGmN4WVIGlqtE1EEpKyWCzYRJIadoE0LAtls0kjO+x8ndmZOefpxcyObCl+JHy8l+f8z/s+5znv+zzvMYAHtLLZcAPYrcD9gAEs1zcSQMAxSHbU65X3AM8AZLP59WD+DMYHqQvgRoTAGFAT9MN6vXzQBEHhIYlDgNNF6dyg4vMR02E3NoZHTCaT/8hau1pSfBOK90AYY5wkSU6YbLYgOt/mRtF+rRBgLB3ab3ZxujUTy/Xv9i8T1r3WHWOuJEWd2ficc/qfQ591bz6uAmBth5A4jkmSBADHcXAchyRJFiSSRBzHSGCt6T1rjEESrVard87zvIXgAGvMQgDWWqIoIo7b5PMFfN9DgiiKqFQu4/tZfN9bACyXy2GtodVqE0URjuPQarUwxlAs9pEkIpXyKZUu98BbY5hLElpxDNlsQdlsQblcUeBpYOBe7dr1ax0+PKrTp0/r5Mkxvfvue3r22a1asmSZHCetfL5fjpPWwMCQTp48qenpab322u/k+4HS6VC5XFG7d+/R5OSkpqamtGXLz+R5GQVBn3LZgkjntLywWM9/bZWYL26Mpw0bNmliYkKNRqRardpL0GhEiqJIR48e1YoV35LvB3LdjAYH1+rChQuKorpGRvbKGE9hWNTevftUqVRUqVT04os/l7UpZbMFhUGfnHSo+/q/qn+ufVj1dRtFLtcnzwu0fPkKjY+Pq1QqaWJiQk899bRuu+0O3XXXN/Tyy7s0PT2tarWqt956W+l0KMdJa3BwjSYmJlStVvX6679XNhtq//4/qlKpaGZmRlu3viBwOgwHfUpl8loS9uujtQ9p9nvr9e/7HxH5fL8Abd68ReVyWaXSjLZv/6UAZTJ5WZuS62Z04MABXbp0SdPT0xoe/r4ADQ2t1eTkpMrlst58c7/27NmrKKrr8uWSnnvueYGrIOhTEPQpDPpEKtDTd3xT1Qc26D/ffVS7V66VTZIEx0mxcuVKjIFGY47R0fex1sfzPMIwpN1ucOTI30ilfNLpFAMDq7rdbrHWUqvVGB5ex2OPrWdmpsRLL/2CnTt/RRDkelMgdZpvMJtDQEviTzOfYCXhOB65XIAEzWaTSqWCZHtjZwyUyxXa7RjP88nlgiuG6dMJmptrUq/XOXTor0htXNftdb4QrrGETsdu5pRQittYYwxx3KJarWEM+L5PGIZYm2Ct7YlJPh/iup0Rq1Zr80pA5wUss7OzAPT3L2LfvhEGB4eYnS3hum4XqqGthEocA5AylqLjYq21xPEc4+OnkCCdTvHgg8PEcZNWq0WlUsXaFMPD65iba9JoNBgbG+9Sm5AkCUGQY3T0fXbs2Im1DsuWLeWNN/7A4OC9lMuXcV0XYyCR+LheBcAzhh8tWoxNkhjPy/LOO39hamoKMDzxxI888SegUCjw2muvsWPHLkZGvuSLL77i9u2v+fjjL3n66cdZvXoVw8PDDA0NcezYMXbt2sXY2BgHDx5k9+7dfPLJJ+zcuZOXXtpPFEWUSqUsLi5y+fIc8/ML3LlzkYmJLyiVXnL//iWKogjnFz0IzFoCH4dAbxHk9bK3F96EuXPXMW3bNnPt2jXq9TpTU1McMPuQwq2bAwMDrNq4kaWlpTk7e/Yss3PnjHLuXbRmq1q6c4P9Z29iF0N7OXm1DcAAAAAAElFTkSuQmCC', 'base64');

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
      const tagList = tags.split(',').map(t=>t.trim()).filter(Boolean);
      for (const tag of tagList) { params.push(tag); where.push(`$${params.length}=ANY(p.tags)`); }
    }
    if (smartListId) {
      const listR = await pool.query('SELECT filters FROM smart_lists WHERE id=$1', [smartListId]);
      if (listR.rows[0]?.filters) {
        const f = listR.rows[0].filters;

        // ── SPECIAL: Upcoming Showings 72h ───────────────────────────────────
        if (f.type === 'upcoming_showings_72h') {
          // Join showings → people, annotate with next showing time + last outbound contact
          const shR = await pool.query(`
            SELECT
              p.*,
              MIN(s.showing_time)                                              AS next_showing_time,
              s2.property                                                      AS showing_property,
              s2.unit                                                          AS showing_unit,
              s2.showing_type                                                  AS showing_type,
              MAX(a.created_at) FILTER (WHERE a.direction='outbound')         AS last_outbound_at,
              MAX(a.created_at) FILTER (WHERE a.direction='inbound')          AS last_inbound_at
            FROM people p
            JOIN showings s ON s.connect_person_id = p.id::text
              AND s.showing_time BETWEEN NOW() AND NOW() + INTERVAL '72 hours'
              AND s.status = 'Scheduled'
            -- grab property/unit from the soonest showing
            JOIN LATERAL (
              SELECT property, unit, showing_type FROM showings
              WHERE connect_person_id = p.id::text
                AND showing_time BETWEEN NOW() AND NOW() + INTERVAL '72 hours'
                AND status = 'Scheduled'
              ORDER BY showing_time ASC LIMIT 1
            ) s2 ON TRUE
            LEFT JOIN activities a ON a.person_id::text = p.id::text
              AND a.created_at > NOW() - INTERVAL '14 days'
            GROUP BY p.id, s2.property, s2.unit, s2.showing_type
            ORDER BY MIN(s.showing_time) ASC
          `);
          const people = shR.rows.map(p => ({
            ...p, ...(p.custom_fields || {}),
            needs_contact: !p.last_outbound_at  // never been contacted outbound
          }));
          return res.json({ people, total: people.length });
        }
        // ─────────────────────────────────────────────────────────────────────

        if (f.stages?.length > 1) { params.push(f.stages); where.push(`p.stage=ANY($${params.length})`); }
        else if (f.stage)  { params.push(f.stage); where.push(`p.stage=$${params.length}`); }
        if (f.tags?.length) {
          params.push(f.tags);
          where.push(`p.tags && $${params.length}::text[]`);
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
    // Spread custom_fields into each person row so frontend gets flat access (past_due_balance etc.)
    const people = r.rows.map(p => ({ ...p, ...(p.custom_fields || {}) }));
    res.json({ people, total: parseInt(countR.rows[0].count) });
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
    const row = r.rows[0];
    res.json({ ...row, ...(row.custom_fields || {}) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/people', auth, async (req, res) => {
  try {
    const { firstName, lastName, phone, email, stage, source, background, tags, customFields, assignedTo, address, city, state, zip } = req.body;
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
    const r = await pool.query(
      'INSERT INTO people (first_name,last_name,phone,email,stage,source,background,tags,custom_fields,assigned_to,address,city,state,zip) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',
      [firstName, lastName, phone||null, email||null, stage||'lead', source||null, background||null, tags||[], JSON.stringify(customFields||{}), assignedTo||null, address||null, city||null, state||null, zip||null]
    );
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
    const rels = await pool.query(`
      SELECT
        CASE WHEN pr.person_id_a = $1 THEN pr.person_id_b ELSE pr.person_id_a END AS cw_id
      FROM person_relationships pr
      WHERE (pr.person_id_a = $1 OR pr.person_id_b = $1)
        AND pr.label = 'caseworker'
    `, [residentId]);
    if (!rels.rows.length) return;
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
      const cwRes = await pool.query(`
        SELECT p.id, p.first_name, p.last_name, pp.phone
        FROM people p
        LEFT JOIN person_phones pp ON pp.person_id = p.id AND pp.is_primary = true
        WHERE p.id = $1
      `, [cwId]);
      const cw = cwRes.rows[0];
      if (!cw) continue;
      const cwName = [cw.first_name, cw.last_name].filter(Boolean).join(' ');
      await pool.query(
        `INSERT INTO activities (person_id, agent_id, type, body, direction)
         VALUES ($1, $2, 'note', $3, 'internal')`,
        [residentId, agentId || null, `📋 Caseworker ${cwName} notified: ${triggerType.replace('_',' ')}`]
      );
      await pool.query(
        `INSERT INTO activities (person_id, agent_id, type, body, direction)
         VALUES ($1, $2, 'note', $3, 'internal')`,
        [cwId, agentId || null, `📋 Notified re: resident ${resName} — ${triggerType.replace('_',' ')}`]
      );
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
    if (stage && (stage === 'Delinquent' || stage === 'Evicting')) {
      const agentId = req.agent?.id || null;
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

// ── SECURITY PROFILE ─────────────────────────────────────────────────────
app.post('/api/people/:id/id-photo', auth, async (req, res) => {
  try {
    let { photoB64, photoName } = req.body;
    if (!photoB64) return res.status(400).json({ error: 'photoB64 required' });
    if (photoB64.startsWith('data:')) { photoB64 = photoB64.split(',')[1]; }
    if (photoB64.length > 7000000) return res.status(413).json({ error: 'Image too large (max ~5MB)' });
    await pool.query(
      'UPDATE people SET id_photo_b64=$1, id_photo_name=$2, updated_at=NOW() WHERE id=$3',
      [photoB64, photoName || 'id-photo', req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/people/:id/id-photo', auth, async (req, res) => {
  try {
    await pool.query('UPDATE people SET id_photo_b64=NULL, id_photo_name=NULL, updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

app.post('/api/people/:id/lease-violation', auth, async (req, res) => {
  try {
    const { note } = req.body;
    const agentId = req.agent?.id || null;
    const body = note ? `🚨 Lease Violation: ${note}` : '🚨 Lease Violation logged';
    const act = await pool.query(
      `INSERT INTO activities (person_id, agent_id, type, body, direction)
       VALUES ($1, $2, 'note', $3, 'internal') RETURNING *`,
      [req.params.id, agentId, body]
    );
    await notifyCaseworkers(req.params.id, 'lease_violation', agentId);
    res.json(act.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

// ─── INBOX ─────────────────────────────────────────────────────────────────────
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

app.post('/api/inbox/clear', auth, async (req, res) => {
  try {
    const { type } = req.body;
    if (type === 'missed' || type === 'all') {
      await pool.query(`UPDATE calls SET inbox_cleared=true WHERE direction='inbound' AND status IN ('no-answer','busy','failed','canceled') AND created_at > NOW() - INTERVAL '7 days'`);
    }
    if (type === 'texts' || type === 'all') {
      await pool.query(`UPDATE activities SET inbox_cleared=true WHERE type='sms' AND direction='inbound' AND created_at > NOW() - INTERVAL '7 days'`);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/security/events/clear', auth, async (req, res) => {
  try {
    await pool.query(`UPDATE security_events SET dismissed=true WHERE dismissed=false`);
    res.json({ ok: true });
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
    const { personId, type, body, duration, recordingUrl, callId, direction, mentions, emailSubject } = req.body;
    const r = await pool.query(
      `INSERT INTO activities (person_id,agent_id,type,body,duration,recording_url,call_id,direction,mentions,email_subject)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [personId, req.agent.id, type||'note', body||null, duration||null, recordingUrl||null, callId||null,
       direction||'outbound', mentions||[], emailSubject||null]
    );
    const activity = r.rows[0];
    if (body && (mentions?.length || body.includes('@'))) {
      const agentNames = mentions || [];
      if (agentNames.length) {
        const personR = await pool.query('SELECT first_name, last_name FROM people WHERE id=$1', [personId]);
        const personName = personR.rows[0] ? `${personR.rows[0].first_name} ${personR.rows[0].last_name||''}`.trim() : 'a contact';
        for (const mentionedName of agentNames) {
          const agR = await pool.query('SELECT id FROM agents WHERE LOWER(name) LIKE LOWER($1) LIMIT 1', [`%${mentionedName}%`]);
          if (agR.rows[0] && String(agR.rows[0].id) !== String(req.agent.id)) {
            await createNotification({
              recipientId: agR.rows[0].id,
              senderId: req.agent.id,
              type: 'mention',
              personId: personId,
              activityId: activity.id,
              body: `${req.agent.name} mentioned you in a note on ${personName}: "${body.substring(0,120)}"`
            });
          }
        }
      }
    }
    res.json(activity);
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
    // Record deletion so default lists don't re-seed on next deploy
    const delR = await pool.query('SELECT name FROM smart_lists WHERE id=$1', [req.params.id]);
    await pool.query('DELETE FROM smart_lists WHERE id=$1', [req.params.id]);
    if (delR.rows[0]?.name) {
      await pool.query(
        `INSERT INTO deleted_smart_lists (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
        [delR.rows[0].name]
      ).catch(()=>{});
    }
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

// ─── TWILIO TOKEN ─────────────────────────────────────────────────────────────
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
// FIX: type is now 'sms' (was 'text') to match inbox query and inbound webhook
app.post('/api/twilio/sms', auth, async (req, res) => {
  try {
    const twilio = initTwilioFull() || initTwilio();
    if (!twilio) return res.status(503).json({ error: 'Twilio not configured' });

    const { to, body, personId, lineId } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'Missing to or body' });

    let fromNumber = process.env.TWILIO_RESIDENT_NUMBER || '+14052562614';
    if (lineId) {
      const lineR = await pool.query('SELECT twilio_number FROM call_lines WHERE id=$1', [lineId]);
      if (lineR.rows[0]) fromNumber = lineR.rows[0].twilio_number;
    }

    // FIX: type changed from 'text' to 'sms' so outbound messages appear in inbox
    const actR = await pool.query(
      `INSERT INTO activities (person_id, agent_id, type, body, direction, sms_status)
       VALUES ($1, $2, 'sms', $3, 'outbound', 'sending') RETURNING *`,
      [personId || null, req.agent.id, body]
    );
    const activityId = actR.rows[0].id;

    const statusCallbackUrl = process.env.APP_URL
      ? `${process.env.APP_URL}/api/twilio/sms-status?activityId=${activityId}`
      : null;

    try {
      const msgParams = { body, from: fromNumber, to };
      if (statusCallbackUrl) msgParams.statusCallback = statusCallbackUrl;
      const message = await twilio.messages.create(msgParams);
      await pool.query(
        `UPDATE activities SET message_sid=$1, sms_status='sent' WHERE id=$2`,
        [message.sid, activityId]
      );
      res.json({ ok: true, sid: message.sid, activityId });
    } catch (twilioErr) {
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
  res.sendStatus(200);
  try {
    const { activityId } = req.query;
    const { MessageStatus, MessageSid, ErrorCode, ErrorMessage } = req.body;
    if (!activityId) return;
    const statusMap = {
      queued: 'sending', accepted: 'sending', sending: 'sending',
      sent: 'sent', delivered: 'delivered', undelivered: 'failed', failed: 'failed'
    };
    const mapped = statusMap[MessageStatus] || MessageStatus;
    const errorMsg = ErrorCode ? `Error ${ErrorCode}: ${ErrorMessage || MessageStatus}` : null;
    await pool.query(
      `UPDATE activities SET sms_status=$1, sms_error=$2, message_sid=COALESCE($3, message_sid) WHERE id=$4`,
      [mapped, errorMsg, MessageSid || null, activityId]
    );
  } catch (e) { console.error('SMS status webhook error:', e.message); }
});

// ─── SMS INBOUND WEBHOOK ──────────────────────────────────────────────────────
// FIX: This route was missing entirely — inbound texts were silently dropped.
// In Twilio Console → Phone Numbers → +14052562614 → Messaging → set:
//   "A message comes in" → Webhook → https://connect.okcreal.com/api/twilio/sms-inbound → HTTP POST
app.post('/api/twilio/sms-inbound', async (req, res) => {
  res.sendStatus(200); // respond immediately so Twilio doesn't retry
  try {
    const { From, Body, To } = req.body;
    if (!From || !Body) return;

    const normalized = From.replace(/\D/g, '').slice(-10);

    // Look up person — check person_phones first, then people.phone fallback
    let person = null;
    const ppR = await pool.query(
      `SELECT p.* FROM people p
       JOIN person_phones pp ON pp.person_id = p.id
       WHERE RIGHT(REGEXP_REPLACE(pp.phone, '[^0-9]', '', 'g'), 10) = $1
         AND (pp.is_bad IS NULL OR pp.is_bad = false)
       LIMIT 1`,
      [normalized]
    );
    if (ppR.rows.length) {
      person = ppR.rows[0];
    } else {
      const pR = await pool.query(
        `SELECT * FROM people WHERE RIGHT(REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = $1 LIMIT 1`,
        [normalized]
      );
      person = pR.rows[0] || null;
    }

    // Save as type 'sms' inbound activity
    const actR = await pool.query(
      `INSERT INTO activities (person_id, type, body, direction, sms_status, created_at)
       VALUES ($1, 'sms', $2, 'inbound', 'received', NOW()) RETURNING *`,
      [person?.id || null, Body]
    );

    if (!person) {
      console.log(`[SMS Inbound] Unmatched number ${From}: "${Body.substring(0, 80)}"`);
    } else {
      console.log(`[SMS Inbound] From ${person.first_name} ${person.last_name||''} (${From}): "${Body.substring(0, 80)}"`);
    }

    // Real-time push to all connected agents
    broadcastToAll({
      type: 'inbound_sms',
      activityId: actR.rows[0].id,
      personId: person?.id || null,
      personName: person ? `${person.first_name} ${person.last_name || ''}`.trim() : From,
      from: From,
      body: Body,
      createdAt: actR.rows[0].created_at
    });

    // Create notifications for all active agents
    try {
      const agentsR = await pool.query('SELECT id FROM agents WHERE is_active=true');
      const preview = Body.length > 80 ? Body.substring(0, 80) + '…' : Body;
      const senderName = person ? `${person.first_name} ${person.last_name||''}`.trim() : From;
      for (const ag of agentsR.rows) {
        await createNotification({
          recipientId: ag.id,
          type: 'inbound_sms',
          personId: person?.id || null,
          activityId: actR.rows[0].id,
          body: `💬 ${senderName}: "${preview}"`
        });
      }
    } catch(e) { console.warn('[SMS Notif]', e.message); }

  } catch (e) {
    console.error('[SMS Inbound] Error:', e.message);
  }
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

app.post('/api/twilio/inbound-complete', async (req, res) => {
  res.type('xml').send('<Response></Response>');
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
        const audioBuffer = await new Promise((resolve, reject) => {
          const https = require('https');
          const url   = new URL(recUrl);
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
    const activityBody = summary || (transcript ? transcript.substring(0, 300) : 'Call recorded. No transcript available.');
    await pool.query('UPDATE activities SET body=$1, recording_url=$2 WHERE call_id=$3', [activityBody, recUrl, call.id]).catch((e) => { console.error('Activity update error:', e.message); });
  } catch (e) { console.error('Recording webhook error:', e.message); }
});

app.post('/api/twilio/recording/retry/:callId', auth, async (req, res) => {
  try {
    const callR = await pool.query('SELECT * FROM calls WHERE id=$1', [req.params.callId]);
    const call = callR.rows[0];
    if (!call?.recording_url) return res.status(404).json({ error: 'No recording found' });
    res.json({ ok: true, message: 'Retrying transcription...' });
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

app.get('/api/calls/:callId/recording', async (req, res) => {
  try {
    const headerToken = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    const queryToken  = req.query.token || null;
    const token = headerToken || queryToken;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    let agentId;
    try { agentId = jwt.verify(token, JWT_SECRET).id; } catch(e) { return res.status(401).json({ error: 'Unauthorized' }); }
    const agentR = await pool.query('SELECT id FROM agents WHERE id=$1 AND is_active=true', [agentId]);
    if (!agentR.rows[0]) return res.status(401).json({ error: 'Unauthorized' });
    const callR = await pool.query(
      `SELECT COALESCE(c.recording_url, a.recording_url) AS recording_url
       FROM calls c
       LEFT JOIN activities a ON a.call_id::text = c.id::text
       WHERE c.id::text = $1
       LIMIT 1`,
      [req.params.callId]
    );
    let recUrl = callR.rows[0]?.recording_url;
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
app.get('/api/config/maps-key', auth, (req, res) => {
  res.json({ key: process.env.GOOGLE_MAPS_API_KEY || null });
});

app.get('/api/admin/agents', auth, adminOnly, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,name,email,role,phone,avatar_color,is_active,created_at FROM agents ORDER BY name');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FUB IMPORT ────────────────────────────────────────────────────────────────
const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function fubParseCSV(raw) {
  const cleaned = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows2D = [[]];
  let cur = '', inQ = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '"') {
      if (!inQ) { inQ = true; continue; }
      if (cleaned[i+1] === '"') { cur += '"'; i++; continue; }
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
  await run(`CREATE TABLE IF NOT EXISTS agents (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT DEFAULT 'agent', phone TEXT, avatar_color TEXT DEFAULT '#6366f1', is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`, 'create agents');
  await run(`CREATE TABLE IF NOT EXISTS people (id SERIAL PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT, phone TEXT, email TEXT, stage TEXT DEFAULT 'lead', source TEXT, background TEXT, tags TEXT[] DEFAULT '{}', custom_fields JSONB DEFAULT '{}', assigned_to TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`, 'create people');
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
  await run(`CREATE TABLE IF NOT EXISTS security_events (id SERIAL PRIMARY KEY, event_id TEXT UNIQUE, unifi_person_id TEXT, camera_mac TEXT, camera_name TEXT, site TEXT, event_link TEXT, thumbnail_b64 TEXT, triggered_at TIMESTAMPTZ DEFAULT NOW(), alarm_name TEXT, raw_payload TEXT, dismissed BOOLEAN DEFAULT FALSE)`, 'create security_events');
  await run(`CREATE TABLE IF NOT EXISTS protect_cameras (id SERIAL PRIMARY KEY, mac TEXT UNIQUE NOT NULL, name TEXT NOT NULL, site TEXT DEFAULT 'Main')`, 'create protect_cameras');
  const knownCams = [['847848B2C827', 'Marlin Rear Overwatch', 'Marlin']];
  for (const [mac, name, site] of knownCams) {
    await pool.query(`INSERT INTO protect_cameras (mac,name,site) VALUES($1,$2,$3) ON CONFLICT (mac) DO NOTHING`, [mac, name, site]).catch(()=>{});
  }
  await run(`UPDATE people SET stage='Resident' WHERE stage='Active Tenant'`, 'migrate Active Tenant->Resident');
  await run(`UPDATE people SET stage='Contractor' WHERE stage='Vendor'`, 'migrate Vendor->Contractor');
  if (process.env.PROTECT_CLOUD_BASE_URL) {
    await pool.query(`UPDATE security_events SET event_link = $1 || '/protect/events/event/' || event_id WHERE event_id IS NOT NULL AND (event_link IS NULL OR event_link NOT LIKE '%/event/%')`, [process.env.PROTECT_CLOUD_BASE_URL]).catch(e => console.warn('Fix event_links:', e.message));
  }
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS address TEXT`, 'people.address');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS city TEXT`, 'people.city');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS state TEXT`, 'people.state');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS zip TEXT`, 'people.zip');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS fub_id TEXT`, 'people.fub_id');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS dob DATE`, 'people.dob');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT FALSE`, 'people.is_blocked');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS notes TEXT`, 'people.notes');
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
  await run(`CREATE TABLE IF NOT EXISTS person_phones (id SERIAL PRIMARY KEY, person_id INTEGER REFERENCES people(id) ON DELETE CASCADE, phone TEXT NOT NULL, label TEXT DEFAULT 'mobile', is_primary BOOLEAN DEFAULT FALSE, is_bad BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW())`, 'create person_phones');
  await run(`CREATE INDEX IF NOT EXISTS idx_person_phones_person ON person_phones(person_id)`, 'idx_person_phones');
  await run(`CREATE TABLE IF NOT EXISTS person_relationships (id SERIAL PRIMARY KEY, person_id_a INTEGER REFERENCES people(id) ON DELETE CASCADE, person_id_b INTEGER REFERENCES people(id) ON DELETE CASCADE, label TEXT DEFAULT 'household', created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(person_id_a, person_id_b))`, 'create person_relationships');
  await run(`CREATE INDEX IF NOT EXISTS idx_rels_a ON person_relationships(person_id_a)`, 'idx_rels_a');
  await run(`CREATE INDEX IF NOT EXISTS idx_rels_b ON person_relationships(person_id_b)`, 'idx_rels_b');
  await run(`CREATE TABLE IF NOT EXISTS call_lines (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name TEXT NOT NULL, twilio_number TEXT NOT NULL, description TEXT, is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())`, 'create call_lines');
  await run(`CREATE TABLE IF NOT EXISTS line_agents (line_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY (line_id, agent_id))`, 'create line_agents');
  await run(`CREATE TABLE IF NOT EXISTS smart_lists (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name TEXT NOT NULL UNIQUE, filters JSONB DEFAULT '{}', sort_order INTEGER DEFAULT 0)`, 'create smart_lists');
  await pool.query(`ALTER TABLE smart_lists ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`).catch(()=>{});
  await pool.query(`DELETE FROM smart_lists WHERE id NOT IN (SELECT MIN(id) FROM smart_lists GROUP BY name)`).catch(()=>{});
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS smart_lists_name_idx ON smart_lists(name)`, 'smart_lists name index');
  await run(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`, 'create app_settings');
  await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS avatar_b64 TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS gmail_refresh_token TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS gmail_email TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS availability TEXT NOT NULL DEFAULT 'online' CHECK (availability IN ('online','offline','oncall'))`).catch(()=>{});
  await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS phone_personal TEXT`).catch(()=>{});
  await pool.query(`INSERT INTO app_settings(key,value) VALUES('oncall_agent_id','') ON CONFLICT(key) DO NOTHING`).catch(()=>{});
  await pool.query(`INSERT INTO app_settings(key,value) VALUES('afterhours_start','18:00') ON CONFLICT(key) DO NOTHING`).catch(()=>{});
  await pool.query(`INSERT INTO app_settings(key,value) VALUES('afterhours_end','08:00') ON CONFLICT(key) DO NOTHING`).catch(()=>{});
  await pool.query(`INSERT INTO app_settings(key,value) VALUES('emergency_iVR_enabled','true') ON CONFLICT(key) DO NOTHING`).catch(()=>{});
  await pool.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS mentions TEXT[] DEFAULT '{}'`).catch(()=>{});
  await pool.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS email_subject TEXT`).catch(()=>{});
  await run(`CREATE TABLE IF NOT EXISTS notifications (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), recipient_id TEXT NOT NULL, sender_id TEXT, type TEXT NOT NULL DEFAULT 'mention', person_id TEXT, activity_id TEXT, body TEXT, is_read BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW())`, 'create notifications');
  await pool.query(`CREATE INDEX IF NOT EXISTS notif_recipient_idx ON notifications(recipient_id, is_read, created_at DESC)`).catch(()=>{});
  await run(`CREATE TABLE IF NOT EXISTS custom_fields (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), key TEXT UNIQUE NOT NULL, label TEXT NOT NULL, field_type TEXT DEFAULT 'text', options TEXT[], sort_order INTEGER DEFAULT 0)`, 'create custom_fields');
  await run(`CREATE TABLE IF NOT EXISTS calls (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), twilio_call_sid TEXT UNIQUE, person_id TEXT, agent_id TEXT, line_id TEXT, direction TEXT, status TEXT, duration_seconds INTEGER, from_number TEXT, to_number TEXT, recording_url TEXT, recording_sid TEXT, transcript TEXT, summary TEXT, started_at TIMESTAMPTZ DEFAULT NOW(), ended_at TIMESTAMPTZ)`, 'create calls');
  await run(`CREATE TABLE IF NOT EXISTS activities (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), person_id TEXT, agent_id TEXT, call_id TEXT, type TEXT NOT NULL DEFAULT 'note', body TEXT, duration INTEGER, recording_url TEXT, direction TEXT DEFAULT 'outbound', sms_status TEXT DEFAULT NULL, sms_error TEXT DEFAULT NULL, message_sid TEXT DEFAULT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`, 'create activities');
  await run(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS direction TEXT DEFAULT 'outbound'`, 'activities.direction');
  await run(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS sms_status TEXT DEFAULT NULL`, 'activities.sms_status');
  await run(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS sms_error TEXT DEFAULT NULL`, 'activities.sms_error');
  await run(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS message_sid TEXT DEFAULT NULL`, 'activities.message_sid');
  await run(`CREATE TABLE IF NOT EXISTS showings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property TEXT NOT NULL,
    unit TEXT,
    guest_name TEXT,
    email TEXT,
    phone TEXT,
    showing_time TIMESTAMPTZ,
    status TEXT,
    showing_type TEXT,
    assigned_user TEXT,
    description TEXT,
    last_activity_date TIMESTAMPTZ,
    last_activity_type TEXT,
    upload_batch TEXT,
    feedback_sent BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    connect_person_id TEXT,
    UNIQUE(property, guest_name, showing_time)
  )`, 'create showings');
  await run(`ALTER TABLE showings ADD COLUMN IF NOT EXISTS connect_person_id TEXT`, 'showings.connect_person_id');
  // Add feedback_sent column if upgrading existing table
  await run(`ALTER TABLE showings ADD COLUMN IF NOT EXISTS feedback_sent BOOLEAN DEFAULT FALSE`, 'alter showings feedback_sent');
  await run(`CREATE TABLE IF NOT EXISTS showing_feedback (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    showing_id UUID REFERENCES showings(id) ON DELETE CASCADE,
    agent_id TEXT,
    agent_name TEXT,
    verdict TEXT NOT NULL CHECK (verdict IN ('go','no-go','maybe')),
    categories JSONB DEFAULT '[]',
    notes TEXT,
    source TEXT DEFAULT 'agent',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(showing_id, agent_id)
  )`, 'create showing_feedback');
  await run(`ALTER TABLE showing_feedback ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'agent'`, 'alter showing_feedback source');
  await run(`CREATE TABLE IF NOT EXISTS showing_uploads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    filename TEXT,
    uploaded_by TEXT,
    record_count INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`, 'create showing_uploads');

  await run(`CREATE TABLE IF NOT EXISTS rent_roll (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    property TEXT NOT NULL,
    unit TEXT NOT NULL,
    tenant_name TEXT,
    status TEXT,
    bedrooms TEXT,
    sqft INTEGER,
    market_rent NUMERIC(10,2),
    rent NUMERIC(10,2),
    deposit NUMERIC(10,2),
    lease_from DATE,
    lease_to DATE,
    move_in DATE,
    move_out DATE,
    past_due NUMERIC(10,2) DEFAULT 0,
    nsf_count INTEGER DEFAULT 0,
    late_count INTEGER DEFAULT 0,
    upload_batch TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(property, unit)
  )`, 'create rent_roll');
  await run(`CREATE TABLE IF NOT EXISTS rent_roll_uploads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    filename TEXT,
    uploaded_by TEXT,
    unit_count INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`, 'create rent_roll_uploads');
  await run(`CREATE TABLE IF NOT EXISTS work_orders (
    id SERIAL PRIMARY KEY,
    property TEXT NOT NULL,
    wo_number TEXT,
    priority TEXT,
    wo_type TEXT,
    job_description TEXT,
    status TEXT,
    vendor TEXT,
    unit TEXT,
    resident TEXT,
    created_at TIMESTAMPTZ,
    scheduled_start TIMESTAMPTZ,
    completed_on TIMESTAMPTZ,
    amount NUMERIC,
    upload_batch UUID,
    imported_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(wo_number)
  )`, 'create work_orders');
  await run(`CREATE TABLE IF NOT EXISTS work_order_uploads (id SERIAL PRIMARY KEY, filename TEXT, uploaded_by TEXT, record_count INTEGER, created_at TIMESTAMPTZ DEFAULT NOW())`, 'create work_order_uploads');

  await run(`CREATE TABLE IF NOT EXISTS tasks (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), person_id TEXT, agent_id TEXT, title TEXT NOT NULL, note TEXT, due_date DATE, completed BOOLEAN DEFAULT false, completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`, 'create tasks');

  // Seed admin
  try {
    const exists = await pool.query(`SELECT 1 FROM agents WHERE email='admin@okcreal.com'`);
    if (exists.rows.length === 0) {
      const hash = await bcrypt.hash('password', 10);
      await pool.query(`INSERT INTO agents (name,email,password_hash,role) VALUES ('Admin','admin@okcreal.com',$1,'admin')`, [hash]);
      console.log('[DB] Admin seeded');
    }
  } catch (e) { console.error('[DB] seed admin:', e.message); }

  // Seed smart lists — only on first boot (DO NOTHING so deletes by users are respected)
  // Add a 'deleted_smart_list_names' table to track user-deleted defaults
  await run(`CREATE TABLE IF NOT EXISTS deleted_smart_lists (name TEXT PRIMARY KEY, deleted_at TIMESTAMPTZ DEFAULT NOW())`, 'create deleted_smart_lists');
  try {
    const smartListDefs = [
      { name: 'Delinquent Residents', filters: { stage: 'Delinquent' }, sort_order: 0 },
      { name: 'Delinquent Leads',     filters: { stage: 'Lead', tags: ['Delinquent'] }, sort_order: 1 },
      { name: 'Active Residents',     filters: { stage: 'Resident' }, sort_order: 2 },
      { name: 'Active Leads',         filters: { stage: 'Lead' }, sort_order: 3 },
      { name: 'Evicting',             filters: { stage: 'Evicting' }, sort_order: 4 },
      { name: 'Past Clients',         filters: { stage: 'Past Tenant' }, sort_order: 5 },
      { name: '🏠 Upcoming Showings',  filters: { type: 'upcoming_showings_72h' }, sort_order: 1 },
    ];
    // Get list of user-deleted default lists so we don't recreate them
    const deletedR = await pool.query('SELECT name FROM deleted_smart_lists');
    const deletedNames = new Set(deletedR.rows.map(r => r.name));
    for (const sl of smartListDefs) {
      if (deletedNames.has(sl.name)) continue; // user deleted this — respect their choice
      await pool.query(
        `INSERT INTO smart_lists (name,filters,sort_order) VALUES($1,$2::jsonb,$3) ON CONFLICT (name) DO NOTHING`,
        [sl.name, JSON.stringify(sl.filters), sl.sort_order]
      ).catch(()=>{});
    }
  } catch (e) { console.error('[DB] seed smart_lists:', e.message); }

  // Seed custom fields
  try {
    await pool.query(`INSERT INTO custom_fields (key,label,field_type,sort_order) VALUES ('past_due_balance','Past Due Balance','number',0), ('past_due_days','Days Past Due','number',1), ('payment_commitment_date','Payment Commitment Date','date',2), ('unit_number','Unit Number','text',3), ('lease_end_date','Lease End Date','date',4) ON CONFLICT (key) DO NOTHING`);
  } catch (e) { console.error('[DB] seed custom_fields:', e.message); }

  // Seed call line
  try {
    await pool.query(`DELETE FROM call_lines WHERE id::text NOT IN (SELECT MIN(id::text) FROM call_lines GROUP BY twilio_number)`).catch(e => console.warn('[DB] dedup call_lines:', e.message));
    await pool.query(`INSERT INTO call_lines (name,twilio_number,description) VALUES ('OKCREAL Connect Line','+14052562614','Main OKCREAL line') ON CONFLICT DO NOTHING`);
    const lineR = await pool.query(`SELECT id FROM call_lines WHERE twilio_number='+14052562614' LIMIT 1`);
    const agentsR = await pool.query(`SELECT id FROM agents WHERE is_active=true`);
    if (lineR.rows[0]) {
      for (const agent of agentsR.rows) {
        await pool.query(`INSERT INTO line_agents (line_id,agent_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [lineR.rows[0].id, agent.id]).catch(() => {});
      }
      console.log(`[DB] Linked ${agentsR.rows.length} agent(s) to call line`);
    }
  } catch (e) { console.error('[DB] seed call_lines:', e.message); }

  console.log('[DB] Init complete');
}

// ══════════════════════════════════════════════════════════════════════════
// JIREH SECURITY — UniFi Protect Webhook + SSE
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/security/stream', auth, (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(':ok\n\n');
  const client = { res, agentId: req.agent?.id };
  sseClients.add(client);
  const ping = setInterval(() => {
    try { res.write(':ping\n\n'); } catch(e) { clearInterval(ping); sseClients.delete(client); }
  }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(client); });
});

app.get('/api/security/events/raw', auth, adminOnly, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, event_id, event_link, camera_mac, site, raw_payload FROM security_events ORDER BY triggered_at DESC LIMIT 5');
    res.json(r.rows.map(row => ({ id: row.id, event_id: row.event_id, event_link: row.event_link, camera_mac: row.camera_mac, site: row.site, payload: row.raw_payload ? JSON.parse(row.raw_payload) : null })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/security/events', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT se.*, p.first_name, p.last_name, p.id as person_id, p.stage,
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

app.get('/api/admin/cameras', auth, adminOnly, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM protect_cameras ORDER BY site, name'); res.json(r.rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/admin/cameras', auth, adminOnly, async (req, res) => {
  const { mac, name, site } = req.body;
  try {
    const r = await pool.query(`INSERT INTO protect_cameras (mac,name,site) VALUES($1,$2,$3) ON CONFLICT (mac) DO UPDATE SET name=$2, site=$3 RETURNING *`, [mac.toUpperCase(), name, site || 'Main']);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/admin/cameras/:mac', auth, adminOnly, async (req, res) => {
  const { name, site } = req.body;
  try {
    const r = await pool.query(`INSERT INTO protect_cameras (mac,name,site) VALUES($1,$2,$3) ON CONFLICT (mac) DO UPDATE SET name=$2, site=COALESCE($3, protect_cameras.site) RETURNING *`, [req.params.mac.toUpperCase(), name, site || null]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/cameras/:id', auth, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM protect_cameras WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});
app.post('/api/admin/cameras/bulk', auth, adminOnly, async (req, res) => {
  const { cameras } = req.body;
  if (!Array.isArray(cameras)) return res.status(400).json({ error: 'cameras array required' });
  let saved = 0;
  for (const cam of cameras) {
    if (!cam.mac) continue;
    const mac = cam.mac.replace(/:/g, '').toUpperCase();
    await pool.query(`INSERT INTO protect_cameras (mac, name, site) VALUES($1,$2,$3) ON CONFLICT (mac) DO UPDATE SET name=EXCLUDED.name, site=COALESCE(EXCLUDED.site, protect_cameras.site)`, [mac, cam.name || mac, cam.site || 'Marlin']).catch(() => {});
    saved++;
  }
  res.json({ saved });
});
app.post('/api/admin/cameras/discover', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT DISTINCT camera_mac AS mac, site FROM security_events WHERE camera_mac IS NOT NULL AND camera_mac != ''`);
    let added = 0;
    for (const row of rows) {
      const r = await pool.query(`INSERT INTO protect_cameras (mac, name, site) VALUES($1,$2,$3) ON CONFLICT (mac) DO NOTHING RETURNING id`, [row.mac.toUpperCase(), row.mac.toUpperCase(), row.site || 'Main']);
      if (r.rowCount) added++;
    }
    res.json({ discovered: rows.length, added });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/protect/webhook', async (req, res) => {
  const secret = process.env.PROTECT_WEBHOOK_SECRET;
  if (secret) {
    const provided = req.query.token || req.headers['x-webhook-token'];
    if (provided !== secret) { console.warn('[Jireh] Webhook rejected — bad token'); return res.status(401).json({ error: 'Unauthorized' }); }
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
    const cloudBase = process.env.PROTECT_CLOUD_BASE_URL || '';
    const cloudLink = cloudBase && eventId ? `${cloudBase}/protect/events/event/${eventId}` : (cloudBase && eventPath ? `${cloudBase}${eventPath}` : localLink);
    const camRow = deviceMac ? await pool.query('SELECT name, site FROM protect_cameras WHERE mac=$1', [deviceMac]).then(r=>r.rows[0]) : null;
    const cameraName = camRow?.name || deviceMac || 'Unknown Camera';
    const site       = camRow?.site || alarm.name || '';
    const personId = trigger.personId || trigger.metadata?.personId || trigger.metadata?.face?.personId || null;
    const thumbnail = body.thumbnail || alarm.thumbnail || null;
    let matchedPerson = null;
    if (personId) {
      const pRow = await pool.query('SELECT id, first_name, last_name, stage FROM people WHERE unifi_person_id=$1 LIMIT 1', [personId]);
      matchedPerson = pRow.rows[0] || null;
    }
    await pool.query(`INSERT INTO security_events (event_id, unifi_person_id, camera_mac, camera_name, site, event_link, thumbnail_b64, triggered_at, alarm_name, raw_payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, personId, deviceMac, cameraName, site, cloudLink || localLink, thumbnail ? thumbnail.substring(0, 500000) : null, new Date(typeof ts === 'number' && ts > 1e12 ? ts : ts * 1000), alarm.name || 'Watchlist', JSON.stringify(body).substring(0, 10000)]
    ).catch(e => console.warn('[Jireh] Insert event:', e.message));
    broadcastSecurityEvent({ type: 'poi_detected', eventId, cameraName, site, triggeredAt: ts, eventLink: cloudLink || localLink, thumbnail: thumbnail || null, alarmName: alarm.name || 'Watchlist', person: matchedPerson ? { id: matchedPerson.id, name: `${matchedPerson.first_name||''} ${matchedPerson.last_name||''}`.trim(), stage: matchedPerson.stage } : null });
    res.json({ ok: true, matched: !!matchedPerson });
  } catch(e) { console.error('[Jireh] Webhook error:', e.message); res.status(500).json({ error: e.message }); }
});

// ─── AGENT SSE STREAM ─────────────────────────────────────────────────────────
app.get('/api/events/stream', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const agentId = String(req.agent.id);
  agentConnections.set(agentId, res);
  console.log(`[SSE] Agent ${req.agent.name} connected (${agentConnections.size} total)`);
  res.write(':ok\n\n');

  // Tell ALL agents (including this one) the online count changed — triggers dashboard refresh
  const onlineIds = Array.from(agentConnections.keys());
  broadcastToAll({ type: 'crew_online', onlineCount: onlineIds.length, onlineIds, agentId, name: req.agent.name, event: 'connect' });

  const ping = setInterval(() => {
    try { res.write(':ping\n\n'); }
    catch(e) { clearInterval(ping); agentConnections.delete(agentId); }
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    agentConnections.delete(agentId);
    for (const [personId, map] of presenceMap) {
      if (map.has(agentId)) {
        map.delete(agentId);
        if (!map.size) presenceMap.delete(personId);
        broadcastPresence(personId);
      }
    }
    console.log(`[SSE] Agent ${req.agent.name} disconnected (${agentConnections.size} total)`);
    // Notify remaining agents the count dropped
    const stillOnline = Array.from(agentConnections.keys());
    broadcastToAll({ type: 'crew_online', onlineCount: stillOnline.length, onlineIds: stillOnline, agentId, name: req.agent.name, event: 'disconnect' });
  });
});

// ─── MY PROFILE ───────────────────────────────────────────────────────────────
// Fast availability update — called every time agent changes status
app.post('/api/me/availability', auth, async (req, res) => {
  try {
    const { availability } = req.body;
    if (!['online','busy','offline'].includes(availability)) return res.status(400).json({ error: 'Invalid' });
    await pool.query(`UPDATE agents SET availability=$1, updated_at=NOW() WHERE id=$2`, [availability, req.agent.id]);
    broadcastToAll({ type: 'agent_status', agentId: String(req.agent.id), name: req.agent.name, availability });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,name,email,role,phone,avatar_color,avatar_b64,gmail_email,is_active FROM agents WHERE id=$1', [req.agent.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/me', auth, async (req, res) => {
  try {
    const { name, phone, avatar_color, avatar_b64, availability } = req.body;
    const r = await pool.query(
      `UPDATE agents SET name = COALESCE($1, name), phone = COALESCE($2, phone), avatar_color = COALESCE($3, avatar_color), avatar_b64 = COALESCE($4, avatar_b64), availability = COALESCE($5, availability), updated_at = NOW() WHERE id=$6 RETURNING id,name,email,role,phone,avatar_color,avatar_b64,gmail_email`,
      [name||null, phone||null, avatar_color||null, avatar_b64||null, availability||null, req.agent.id]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/me/password', auth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const r = await pool.query('SELECT password_hash FROM agents WHERE id=$1', [req.agent.id]);
    const ok = await bcrypt.compare(current_password, r.rows[0].password_hash);
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE agents SET password_hash=$1 WHERE id=$2', [hash, req.agent.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── PRESENCE ─────────────────────────────────────────────────────────────────
app.post('/api/presence/enter', auth, async (req, res) => {
  const { personId } = req.body;
  if (!personId) return res.status(400).json({ error: 'personId required' });
  const ar = await pool.query('SELECT id,name,avatar_b64,avatar_color FROM agents WHERE id=$1', [req.agent.id]);
  setPresence(personId, ar.rows[0]);
  res.json({ ok: true });
});

app.post('/api/presence/leave', auth, async (req, res) => {
  const { personId } = req.body;
  if (!personId) return res.status(400).json({ error: 'personId required' });
  clearPresence(personId, req.agent.id);
  res.json({ ok: true });
});

app.get('/api/presence/:personId', auth, (req, res) => {
  const map = presenceMap.get(String(req.params.personId));
  const viewers = map ? Array.from(map.values()) : [];
  res.json({ viewers });
});

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
app.get('/api/notifications', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT n.*, a.name as sender_name, a.avatar_b64 as sender_avatar, a.avatar_color as sender_color, p.first_name, p.last_name
       FROM notifications n
       LEFT JOIN agents a ON a.id::text = n.sender_id
       LEFT JOIN people p ON p.id::text = n.person_id
       WHERE n.recipient_id = $1
       ORDER BY n.created_at DESC LIMIT 50`,
      [String(req.agent.id)]
    );
    const unread = r.rows.filter(n => !n.is_read).length;
    res.json({ notifications: r.rows, unread });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/notifications/:id/read', auth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read=true WHERE id=$1 AND recipient_id=$2', [req.params.id, String(req.agent.id)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notifications/read-all', auth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read=true WHERE recipient_id=$1', [String(req.agent.id)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function createNotification({ recipientId, senderId, type, personId, activityId, body }) {
  try {
    const r = await pool.query(
      `INSERT INTO notifications (recipient_id, sender_id, type, person_id, activity_id, body) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [String(recipientId), senderId ? String(senderId) : null, type, personId ? String(personId) : null, activityId ? String(activityId) : null, body]
    );
    sendToAgent(recipientId, { type: 'notification', notification: r.rows[0] });
    return r.rows[0];
  } catch(e) { console.error('[notification]', e.message); }
}

// ─── GMAIL ────────────────────────────────────────────────────────────────────
app.get('/api/gmail/connect', async (req, res) => {
  const token = req.query.token || (req.headers.authorization?.slice(7));
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  let agent;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const r = await pool.query('SELECT * FROM agents WHERE id=$1 AND is_active=true', [decoded.id]);
    if (!r.rows[0]) return res.status(401).json({ error: 'Unauthorized' });
    agent = r.rows[0];
  } catch(e) { return res.status(401).json({ error: 'Unauthorized' }); }
  if (!process.env.GMAIL_CLIENT_ID) return res.status(400).json({ error: 'GMAIL_CLIENT_ID not set' });
  const oauth2 = getGmailOAuth(agent);
  const url = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.settings.basic', 'https://www.googleapis.com/auth/userinfo.email'], state: String(agent.id) });
  res.redirect(url);
});

app.get('/api/gmail/callback', async (req, res) => {
  const { code, state: agentId } = req.query;
  if (!code || !agentId) return res.send('Missing params.');
  try {
    const oauth2 = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.APP_URL + '/api/gmail/callback');
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const gmailEmail = profile.data.emailAddress;
    await pool.query(`UPDATE agents SET gmail_refresh_token=$1, gmail_email=$2 WHERE id=$3`, [tokens.refresh_token || null, gmailEmail, agentId]);
    res.send(`<script>window.close();</script><p>Gmail connected (${gmailEmail}). You can close this tab.</p>`);
  } catch(e) { res.send('Error: ' + e.message); }
});

app.post('/api/gmail/disconnect', auth, async (req, res) => {
  try {
    await pool.query('UPDATE agents SET gmail_refresh_token=NULL, gmail_email=NULL WHERE id=$1', [req.agent.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/gmail/send', auth, async (req, res) => {
  try {
    const { to, subject, body, personId } = req.body;
    const agentR = await pool.query('SELECT gmail_refresh_token, gmail_email, name FROM agents WHERE id=$1', [req.agent.id]);
    const agent = agentR.rows[0];
    if (!agent.gmail_refresh_token) return res.status(400).json({ error: 'Gmail not connected' });
    const oauth2 = getGmailOAuth(agent);
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    let signature = '';
    try {
      const sendAsRes = await gmail.users.settings.sendAs.get({ userId: 'me', sendAsEmail: agent.gmail_email });
      if (sendAsRes.data.signature) {
        signature = '\r\n\r\n--\r\n' + sendAsRes.data.signature.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
      }
    } catch(sigErr) { console.log('[Gmail] Could not fetch signature:', sigErr.message); }
    const fullBody = body + signature;
    const msgLines = [`From: ${agent.name} <${agent.gmail_email}>`, `To: ${to}`, `Subject: ${subject}`, `Content-Type: text/plain; charset=utf-8`, ``, fullBody];
    const raw = Buffer.from(msgLines.join('\r\n')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    if (personId) {
      await pool.query(`INSERT INTO activities (person_id,agent_id,type,body,direction) VALUES ($1,$2,'email',$3,'outbound')`, [String(personId), String(req.agent.id), `To: ${to}\nSubject: ${subject}\n\n${fullBody}`]);
    }
    res.json({ ok: true });
  } catch(e) { console.error('[Gmail send]', e.message); res.status(500).json({ error: e.message }); }
});

// ─── LEAD INBOUND EMAIL WEBHOOK ───────────────────────────────────────────────
app.post('/api/leads/inbound', async (req, res) => {
  const secret = process.env.LEADS_WEBHOOK_SECRET;
  if (secret && req.query.token !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { subject = '', body = '', from = '' } = req.body;
    if (!subject && !body) return res.json({ skipped: true, reason: 'empty' });
    const OpenAI = require('openai');
    const grok = new OpenAI({ apiKey: process.env.GROK_API_KEY, baseURL: 'https://api.x.ai/v1' });
    const r = await grok.chat.completions.create({ model: 'grok-3', max_tokens: 300, messages: [{ role: 'user', content: `Extract contact info from this lead email. Return ONLY JSON, no markdown.\nFrom: ${from}\nSubject: ${subject}\nBody: ${body.substring(0,2000)}\n\nJSON format: {"first_name":"","last_name":"","email":"","phone":"10 digits only","source":"platform name","property":"","message":"","is_lead":true}\nSet is_lead false for spam/receipts/non-leads.` }] });
    let fields;
    try { fields = JSON.parse(r.choices[0].message.content.replace(/```json?|```/g,'')); }
    catch(e) { return res.json({ skipped: true, reason: 'AI parse fail' }); }
    if (!fields.is_lead) return res.json({ skipped: true, reason: 'not a lead' });
    if (!fields.first_name && !fields.email && !fields.phone) return res.json({ skipped: true, reason: 'no contact info' });
    if (fields.email) {
      const d = await pool.query('SELECT id FROM people WHERE LOWER(email)=LOWER($1) LIMIT 1', [fields.email]);
      if (d.rows[0]) return res.json({ skipped: true, reason: 'dup email', id: d.rows[0].id });
    }
    if (fields.phone) {
      const d = await pool.query(`SELECT id FROM people WHERE regexp_replace(COALESCE(phone,''),'\\D','','g')=$1 LIMIT 1`, [fields.phone.replace(/\D/g,'')]);
      if (d.rows[0]) return res.json({ skipped: true, reason: 'dup phone', id: d.rows[0].id });
    }
    const phone = fields.phone ? '+1' + fields.phone.replace(/\D/g,'').slice(-10) : null;
    const notes = [fields.property && `Interested in: ${fields.property}`, fields.source && `Source: ${fields.source}`, fields.message && `Message: ${fields.message}`].filter(Boolean).join('\n');
    const ins = await pool.query(`INSERT INTO people (first_name,last_name,email,phone,stage,source,notes,updated_at) VALUES ($1,$2,$3,$4,'Lead',$5,$6,NOW()) RETURNING id`, [fields.first_name||'Unknown', fields.last_name||'', fields.email||null, phone, fields.source||'Email Lead', notes||null]);
    broadcastToAll({ type: 'new_lead', personId: ins.rows[0].id, name: `${fields.first_name} ${fields.last_name}`, source: fields.source });
    // Notify all active agents of new inbound lead
    try {
      const agentsR2 = await pool.query('SELECT id FROM agents WHERE is_active=true');
      for (const ag of agentsR2.rows) {
        await createNotification({
          recipientId: ag.id,
          type: 'new_lead',
          personId: String(ins.rows[0].id),
          body: `🏠 New lead: ${fields.first_name} ${fields.last_name||''} (${fields.source||'Web'})`
        });
      }
    } catch(e) {}
    res.json({ created: true, id: ins.rows[0].id });
  } catch(e) { console.error('[leads/inbound]', e.message); res.status(500).json({ error: e.message }); }
});

// =============================================================================
// GROKFUB SERVICE API
// =============================================================================
const GROKFUB_TOKEN = process.env.GROKFUB_SERVICE_TOKEN || 'grokfub-okcreal-2026-bridge-token';

function requireGrokfubToken(req, res, next) {
  const token = req.headers['x-grokfub-token'];
  if (!token || token !== GROKFUB_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/api/grokfub/people', requireGrokfubToken, async (req, res) => {
  try {
    const { phone, tag } = req.query;
    let rows = [];
    if (phone) {
      const digits = phone.replace(/\D/g, '').slice(-10);
      const result = await pool.query(`SELECT p.*, pp.phone as matched_phone FROM people p LEFT JOIN person_phones pp ON pp.person_id = p.id WHERE pp.phone LIKE $1 OR p.phone LIKE $1 LIMIT 5`, [`%${digits}`]);
      rows = result.rows;
    } else if (tag) {
      const result = await pool.query(`SELECT * FROM people WHERE $1 = ANY(tags) ORDER BY updated_at DESC LIMIT 100`, [tag]);
      rows = result.rows;
    } else return res.status(400).json({ error: 'Provide phone or tag' });
    res.json({ people: rows });
  } catch (e) { console.error('[GROKFUB API] GET /people error:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/grokfub/activity', requireGrokfubToken, async (req, res) => {
  try {
    const { person_id, type = 'note', body, subject, direction = 'outbound' } = req.body;
    if (!person_id || !body) return res.status(400).json({ error: 'person_id and body required' });
    await pool.query(`INSERT INTO activities (person_id, type, body, direction, created_at) VALUES ($1, $2, $3, $4, NOW())`, [person_id, type, `[GROKFUB] ${subject ? subject + '\n\n' : ''}${body}`, direction]);
    res.json({ ok: true });
  } catch (e) { console.error('[GROKFUB API] POST /activity error:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/grokfub/people/:id/tags', requireGrokfubToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { add = [], remove = [] } = req.body;
    const { rows } = await pool.query('SELECT tags FROM people WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Person not found' });
    let tags = (rows[0].tags || []).filter(t => !remove.includes(t));
    for (const t of add) { if (!tags.includes(t)) tags.push(t); }
    await pool.query('UPDATE people SET tags = $1, updated_at = NOW() WHERE id = $2', [tags, id]);
    res.json({ ok: true, tags });
  } catch (e) { console.error('[GROKFUB API] POST /tags error:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/grokfub/people/:id/stage', requireGrokfubToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { stage } = req.body;
    if (!stage) return res.status(400).json({ error: 'stage required' });
    await pool.query('UPDATE people SET stage = $1, updated_at = NOW() WHERE id = $2', [stage, id]);
    res.json({ ok: true, stage });
  } catch (e) { console.error('[GROKFUB API] POST /stage error:', e.message); res.status(500).json({ error: e.message }); }
});

// Dedicated debt update — GrokFUB calls this whenever balance or days change
app.post('/api/grokfub/people/:id/debt', requireGrokfubToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { balance, days_past_due, stage } = req.body;
    if (balance == null && days_past_due == null) return res.status(400).json({ error: 'balance or days_past_due required' });
    const cfPatch = {};
    if (balance       != null) cfPatch.past_due_balance = parseFloat(balance);
    if (days_past_due != null) cfPatch.past_due_days    = parseInt(days_past_due);
    const updates = ['custom_fields = custom_fields || $1::jsonb', 'updated_at = NOW()'];
    const params  = [JSON.stringify(cfPatch)];
    if (stage) { params.push(stage); updates.push(`stage = $${params.length}`); }
    params.push(id);
    await pool.query(`UPDATE people SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
    // Broadcast live update to any open Connect tabs
    broadcastToAll({ type: 'debt_update', personId: id, ...cfPatch, ...(stage ? { stage } : {}) });
    console.log(`[GROKFUB API] debt update person ${id}: balance=${cfPatch.past_due_balance ?? 'n/a'} days=${cfPatch.past_due_days ?? 'n/a'}`);
    res.json({ ok: true, ...cfPatch });
  } catch (e) { console.error('[GROKFUB API] debt update error:', e.message); res.status(500).json({ error: e.message }); }
});

// Debug: check what debt data is stored for a person
app.get('/api/grokfub/people/:id/debt-check', requireGrokfubToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, stage, custom_fields,
              custom_fields->>'past_due_balance' AS past_due_balance,
              custom_fields->>'past_due_days'    AS past_due_days
       FROM people WHERE id = $1`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/grokfub/people/:id/acknowledge-trigger', requireGrokfubToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query('SELECT tags FROM people WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Person not found' });
    let tags = (rows[0].tags || []).filter(t => t !== 'Initiate debt collection robot');
    if (!tags.includes('Grok Call In Progress')) tags.push('Grok Call In Progress');
    await pool.query('UPDATE people SET tags = $1, updated_at = NOW() WHERE id = $2', [tags, id]);
    res.json({ ok: true });
  } catch (e) { console.error('[GROKFUB API] acknowledge-trigger error:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/grokfub/bulk-stage-sync', requireGrokfubToken, async (req, res) => {
  try {
    const { tenants = [], clearOthers = false } = req.body;
    let synced = 0, cleared = 0, notFound = 0;

    // Build map: last10digits -> { stage, balance, days_past_due }
    const phoneMap = new Map();
    for (const t of tenants) {
      if (!t.phone) continue;
      const digits = t.phone.replace(/\D/g, '').slice(-10);
      if (digits) phoneMap.set(digits, {
        stage:         t.stage || 'Delinquent',
        balance:       t.balance        != null ? t.balance        : t.past_due_balance  != null ? t.past_due_balance  : null,
        days_past_due: t.days_past_due  != null ? t.days_past_due  : t.days             != null ? t.days             : null,
      });
    }

    for (const [digits, data] of phoneMap.entries()) {
      // Find matching people
      const found = await pool.query(
        `SELECT DISTINCT p.id FROM people p LEFT JOIN person_phones pp ON pp.person_id = p.id
         WHERE RIGHT(REGEXP_REPLACE(p.phone, '[^0-9]', '', 'g'), 10) = $1
            OR RIGHT(REGEXP_REPLACE(pp.phone, '[^0-9]', '', 'g'), 10) = $1`,
        [digits]
      );
      if (!found.rowCount) { notFound++; continue; }

      // Build custom_fields patch — only set keys GrokFUB is providing
      const cfPatch = {};
      if (data.balance       != null) cfPatch.past_due_balance = parseFloat(data.balance);
      if (data.days_past_due != null) cfPatch.past_due_days    = parseInt(data.days_past_due);
      const cfJson = JSON.stringify(cfPatch);

      for (const row of found.rows) {
        await pool.query(
          `UPDATE people SET stage = $1, custom_fields = custom_fields || $2::jsonb, updated_at = NOW() WHERE id = $3`,
          [data.stage, cfJson, row.id]
        );
      }
      synced += found.rowCount;
    }

    if (clearOthers && phoneMap.size > 0) {
      const delinquents = await pool.query(
        `SELECT p.id, p.phone, array_agg(pp.phone) as alt_phones
         FROM people p LEFT JOIN person_phones pp ON pp.person_id = p.id
         WHERE p.stage = 'Delinquent' GROUP BY p.id`
      );
      for (const person of delinquents.rows) {
        const allPhones = [person.phone, ...(person.alt_phones || [])].filter(Boolean).map(ph => ph.replace(/\D/g, '').slice(-10));
        if (!allPhones.some(d => phoneMap.has(d))) {
          await pool.query(
            `UPDATE people SET stage = $1, custom_fields = custom_fields || '{"past_due_balance":null,"past_due_days":null}'::jsonb, updated_at = NOW() WHERE id = $2`,
            ['Resident', person.id]
          );
          cleared++;
        }
      }
    }

    console.log(`[GROKFUB API] bulk-stage-sync: ${synced} synced, ${cleared} cleared, ${notFound} not found`);
    res.json({ ok: true, synced, cleared, notFound });
  } catch (e) { console.error('[GROKFUB API] bulk-stage-sync error:', e.message); res.status(500).json({ error: e.message }); }
});

// =============================================================================
// SHOWINGS API
// =============================================================================

// Upload showings — accepts pre-parsed JSON rows from browser-side SheetJS
// (no server-side xlsx dependency needed)
// Helper: parse AppFolio "Last, First" or "First Last" name format
function parseShowingName(raw) {
  if (!raw) return { first_name: 'Unknown', last_name: '' };
  const s = raw.trim();
  if (s.includes(',')) {
    const [last, ...rest] = s.split(',');
    return { last_name: last.trim(), first_name: rest.join(',').trim() };
  }
  const parts = s.split(' ').filter(Boolean);
  return { first_name: parts[0] || 'Unknown', last_name: parts.slice(1).join(' ') };
}

// Helper: normalize phone to 10 digits
function normPhone(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g,'');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d.length === 10 ? d : null;
}

app.post('/api/showings/upload', auth, async (req, res) => {
  try {
    const { rows, filename } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No rows provided' });
    }

    const batchId = crypto.randomUUID();
    let inserted = 0, skipped = 0, leadsCreated = 0, leadsMatched = 0;

    for (const row of rows) {
      if (!row.guest_name || !row.showing_time) continue;
      try {
        const phone10 = normPhone(row.phone);
        const emailLow = row.email ? row.email.toLowerCase().trim() : null;

        // ── 1. Find or create the Connect lead ──
        let personId = null;

        // Try match by phone first, then email
        if (phone10) {
          const r = await pool.query(
            `SELECT id FROM people WHERE regexp_replace(phone,'\\D','','g') = $1 LIMIT 1`,
            [phone10]
          );
          if (r.rows[0]) { personId = r.rows[0].id; leadsMatched++; }
        }
        if (!personId && emailLow) {
          const r = await pool.query(
            `SELECT id FROM people WHERE LOWER(email) = $1 LIMIT 1`,
            [emailLow]
          );
          if (r.rows[0]) { personId = r.rows[0].id; leadsMatched++; }
        }

        // Create lead if not found
        if (!personId) {
          const { first_name, last_name } = parseShowingName(row.guest_name);
          const propShort = (row.property||'').split(' - ')[0].substring(0, 60);
          const showingDate = new Date(row.showing_time).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
          const notes = `Auto-created from AppFolio showing import.\nProperty: ${propShort}${row.unit ? ' · Unit '+row.unit : ''}\nShowing: ${showingDate}${row.showing_type ? ' ('+row.showing_type+')' : ''}`;
          const ins = await pool.query(
            `INSERT INTO people (first_name, last_name, phone, email, stage, source, background, updated_at)
             VALUES ($1,$2,$3,$4,'Lead','AppFolio Showing',$5,NOW()) RETURNING id`,
            [first_name, last_name,
             phone10 ? phone10 : null,
             emailLow || null,
             notes]
          );
          personId = ins.rows[0].id;
          leadsCreated++;
          broadcastToAll({ type: 'new_lead', personId, name: `${first_name} ${last_name}`.trim(), source: 'AppFolio Showing' });
        }

        // ── 2. Upsert the showing, linking to person ──
        await pool.query(
          `INSERT INTO showings (property,unit,guest_name,email,phone,showing_time,status,showing_type,
                                assigned_user,description,last_activity_date,last_activity_type,
                                upload_batch,connect_person_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (property,guest_name,showing_time) DO UPDATE SET
             status=EXCLUDED.status, last_activity_type=EXCLUDED.last_activity_type,
             last_activity_date=EXCLUDED.last_activity_date, upload_batch=EXCLUDED.upload_batch,
             connect_person_id=EXCLUDED.connect_person_id`,
          [ row.property||null, row.unit||null, row.guest_name.trim(),
            row.email||null, row.phone||null, new Date(row.showing_time),
            row.status||null, row.showing_type||null, row.assigned_user||null,
            row.description||null,
            row.last_activity_date ? new Date(row.last_activity_date) : null,
            row.last_activity_type||null, batchId, String(personId) ]
        );
        inserted++;
      } catch(e) {
        console.warn('[Showings Upload] Row skip:', e.message);
        skipped++;
      }
    }

    if (inserted === 0 && skipped === 0) {
      return res.status(400).json({ error: 'No valid showings found in file. Check file format.' });
    }
    const uploader = req.agent?.name || req.agent?.id || null;
    await pool.query(`INSERT INTO showing_uploads (filename,uploaded_by,record_count) VALUES ($1,$2,$3)`,
      [filename || 'showings.xlsx', uploader, inserted]);
    res.json({ ok: true, inserted, skipped, leadsCreated, leadsMatched, batchId });
  } catch(e) { console.error('[Showings Upload]', e.message); res.status(500).json({ error: e.message }); }
});

// Get property summary
app.get('/api/showings/properties', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        s.property,
        COUNT(*)::int                                            AS total_showings,
        COUNT(*) FILTER (WHERE s.status='Completed')::int       AS completed,
        COUNT(*) FILTER (WHERE s.status='Scheduled')::int       AS scheduled,
        COUNT(*) FILTER (WHERE s.status ILIKE '%Cancel%')::int  AS canceled,
        COUNT(f.id)::int                                        AS feedback_count,
        COUNT(*) FILTER (WHERE f.verdict='go')::int             AS go_count,
        COUNT(*) FILTER (WHERE f.verdict='no-go')::int          AS nogo_count,
        COUNT(*) FILTER (WHERE f.verdict='maybe')::int          AS maybe_count,
        MAX(s.showing_time)                                      AS last_showing
      FROM showings s
      LEFT JOIN showing_feedback f ON f.showing_id = s.id
      GROUP BY s.property
      ORDER BY last_showing DESC NULLS LAST
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get showings for a property
app.get('/api/showings', auth, async (req, res) => {
  try {
    const { property, status } = req.query;
    let where = ['1=1']; const params = [];
    if (property) { params.push(property); where.push(`s.property = $${params.length}`); }
    if (status)   { params.push(status);   where.push(`s.status   = $${params.length}`); }
    const { rows } = await pool.query(`
      SELECT s.*,
        f.verdict, f.categories, f.notes, f.agent_name, f.agent_id AS feedback_agent_id,
        f.created_at AS feedback_at
      FROM showings s
      LEFT JOIN showing_feedback f ON f.showing_id = s.id
      WHERE ${where.join(' AND ')}
      ORDER BY s.showing_time DESC
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Save / update feedback
app.post('/api/showings/:id/feedback', auth, async (req, res) => {
  try {
    const { verdict, categories = [], notes = '' } = req.body;
    if (!verdict) return res.status(400).json({ error: 'verdict required' });
    const agentName = req.agent?.name || 'Agent';
    const agentId   = req.agent?.id   || null;
    await pool.query(
      `INSERT INTO showing_feedback (showing_id,agent_id,agent_name,verdict,categories,notes,source)
       VALUES ($1,$2,$3,$4,$5,$6,'agent')
       ON CONFLICT (showing_id,agent_id) DO UPDATE SET
         verdict=EXCLUDED.verdict, categories=EXCLUDED.categories,
         notes=EXCLUDED.notes, source='agent', created_at=NOW()`,
      [req.params.id, agentId, agentName, verdict, JSON.stringify(categories), notes]
    );
    broadcastToAll({ type: 'showing_feedback', showingId: req.params.id, verdict });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get trends for a property — aggregate categories + notes
app.get('/api/showings/trends', auth, async (req, res) => {
  try {
    const { property } = req.query;
    if (!property) return res.status(400).json({ error: 'property required' });
    const { rows } = await pool.query(`
      SELECT f.verdict, f.categories, f.notes, f.agent_name, f.created_at, s.guest_name, s.showing_time
      FROM showing_feedback f
      JOIN showings s ON s.id = f.showing_id
      WHERE s.property = $1
      ORDER BY f.created_at DESC
    `, [property]);

    // Tally categories
    const catCounts = {};
    let go=0, nogo=0, maybe=0;
    for (const r of rows) {
      if (r.verdict === 'go')     go++;
      if (r.verdict === 'no-go')  nogo++;
      if (r.verdict === 'maybe')  maybe++;
      for (const c of (r.categories || [])) {
        catCounts[c] = (catCounts[c] || 0) + 1;
      }
    }
    const topIssues = Object.entries(catCounts).sort((a,b)=>b[1]-a[1]).map(([cat,count])=>({cat,count}));
    res.json({ go, nogo, maybe, total: rows.length, topIssues, feedback: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Last upload info — for the "stale data" warning
app.get('/api/showings/last-upload', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT filename, uploaded_by, record_count, created_at FROM showing_uploads ORDER BY created_at DESC LIMIT 1`
    );
    res.json(rows[0] || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Upcoming showings — next 90 minutes, used by alert poller
// Also tries to match to a Connect person for "View Lead File" deep-link
app.get('/api/showings/upcoming', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.property, s.unit, s.guest_name, s.phone, s.email,
             s.showing_time, s.status, s.showing_type,
             p.id AS connect_person_id
      FROM showings s
      LEFT JOIN LATERAL (
        SELECT p.id FROM people p
        WHERE (p.phone IS NOT NULL AND p.phone = s.phone)
           OR (p.email IS NOT NULL AND LOWER(p.email) = LOWER(s.email))
        LIMIT 1
      ) p ON TRUE
      WHERE s.status = 'Scheduled'
        AND s.showing_time BETWEEN NOW() AND NOW() + INTERVAL '90 minutes'
      ORDER BY s.showing_time ASC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Showings for a specific contact — matched by phone, email, or name
app.get('/api/showings/by-contact', auth, async (req, res) => {
  try {
    const { phone, email, name } = req.query;
    if (!phone && !email && !name) return res.json([]);

    const conditions = [];
    const params = [];

    if (phone) {
      const digits = phone.replace(/\D/g,'').slice(-10);
      params.push('%' + digits);
      conditions.push(`regexp_replace(s.phone,'[^0-9]','','g') LIKE $${params.length}`);
    }
    if (email) {
      params.push(email.toLowerCase());
      conditions.push(`LOWER(s.email) = $${params.length}`);
    }
    if (name) {
      // AppFolio format: "Last, First" — try fuzzy match
      params.push('%' + name.toLowerCase().replace(/,\s*/,' ').trim() + '%');
      const nameParts = name.split(',').map(x=>x.trim());
      const reversed = (nameParts[1]||'') + ' ' + (nameParts[0]||'');
      params.push('%' + reversed.toLowerCase().trim() + '%');
      conditions.push(`(LOWER(s.guest_name) LIKE $${params.length-1} OR LOWER(s.guest_name) LIKE $${params.length})`);
    }

    const { since } = req.query;
    if (since) {
      params.push(since);
      conditions.push(`1=1`); // placeholder — add date filter below
    }

    const sinceClause = since ? `AND s.showing_time >= $${params.length}` : '';

    const { rows } = await pool.query(`
      SELECT s.*, f.verdict, f.categories, f.notes, f.agent_name, f.source AS feedback_source, f.created_at AS feedback_at
      FROM showings s
      LEFT JOIN showing_feedback f ON f.showing_id = s.id
      WHERE (${conditions.slice(0, since ? conditions.length - 1 : conditions.length).join(' OR ')})
      ${sinceClause}
      ORDER BY s.showing_time DESC
      LIMIT 50
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// SHOWING FEEDBACK — public page + poller
// =============================================================================

// Public feedback submission (no auth — prospect fills this out)
app.get('/feedback/:showingId', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tour Feedback — OKCREAL</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#eee;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{background:#141414;border:1px solid #2a2a2a;border-radius:16px;max-width:480px;width:100%;padding:32px}
  h1{font-size:22px;font-weight:800;margin-bottom:4px;color:#fff}
  .sub{font-size:13px;color:#888;margin-bottom:28px}
  .verdict-row{display:flex;gap:10px;margin-bottom:24px}
  .vbtn{flex:1;padding:16px 8px;border:2px solid #333;border-radius:12px;background:transparent;cursor:pointer;color:#888;font-size:13px;font-weight:700;text-align:center;transition:all .15s}
  .vbtn.go.sel{border-color:#00e87a;color:#00e87a;background:rgba(0,232,122,.08)}
  .vbtn.maybe.sel{border-color:#ff8c00;color:#ff8c00;background:rgba(255,140,0,.08)}
  .vbtn.nogo.sel{border-color:#e8003a;color:#e8003a;background:rgba(232,0,58,.08)}
  .vbtn .emoji{font-size:28px;display:block;margin-bottom:6px}
  label{display:block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#666;margin-bottom:8px}
  .cats{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px}
  .cat{padding:6px 12px;border:1px solid #333;border-radius:20px;font-size:12px;cursor:pointer;color:#888;background:#1a1a1a;transition:all .12s}
  .cat.sel{border-color:#e8003a;color:#e8003a;background:rgba(232,0,58,.08)}
  textarea{width:100%;background:#1a1a1a;border:1px solid #333;border-radius:8px;color:#eee;font-size:14px;padding:12px;resize:vertical;min-height:80px;font-family:inherit;margin-bottom:20px}
  textarea:focus{outline:none;border-color:#444}
  .submit{width:100%;padding:14px;background:#e8003a;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:800;cursor:pointer;letter-spacing:.05em}
  .submit:disabled{opacity:.5;cursor:not-allowed}
  .thanks{text-align:center;padding:40px 0}
  .thanks .big{font-size:48px;margin-bottom:16px}
  .thanks h2{font-size:22px;font-weight:800;margin-bottom:8px;color:#fff}
  .logo{text-align:center;margin-bottom:24px;font-size:13px;letter-spacing:.15em;text-transform:uppercase;color:#555}
</style>
</head>
<body>
<div class="card">
  <div class="logo">OKCREAL</div>
  <div id="form-wrap">
    <h1>How did your tour go?</h1>
    <div class="sub">Your feedback helps us improve every showing.</div>
    <div class="verdict-row">
      <button class="vbtn go" onclick="setV('go',this)"><span class="emoji">✅</span>I'm Interested</button>
      <button class="vbtn maybe" onclick="setV('maybe',this)"><span class="emoji">🤔</span>Maybe</button>
      <button class="vbtn nogo" onclick="setV('no-go',this)"><span class="emoji">❌</span>Not for Me</button>
    </div>
    <label>Anything to flag? (optional)</label>
    <div class="cats" id="cats">
      ${['smell','paint / walls','cleanliness','carpet / flooring','appliances','kitchen','bathroom','lighting','layout','curb appeal','parking','noise','neighborhood','price'].map(c=>`<div class="cat" onclick="toggleCat('${c}',this)">${c}</div>`).join('')}
    </div>
    <label>Other comments</label>
    <textarea id="notes" placeholder="Tell us what you think..."></textarea>
    <button class="submit" id="submit-btn" onclick="submitFeedback()" disabled>Select a rating above to continue</button>
  </div>
  <div id="thanks" class="thanks" style="display:none">
    <div class="big">🎉</div>
    <h2>Thank you!</h2>
    <p style="color:#888;font-size:14px;margin-top:8px">We appreciate you taking the time to share your thoughts. Our team will be in touch soon!</p>
  </div>
</div>
<script>
  let verdict=null, cats=[];
  function setV(v, el) {
    verdict=v;
    document.querySelectorAll('.vbtn').forEach(b=>b.classList.remove('sel'));
    el.classList.add('sel');
    const btn=document.getElementById('submit-btn');
    btn.disabled=false; btn.textContent='Submit Feedback';
  }
  function toggleCat(c, el) {
    if (cats.includes(c)) { cats=cats.filter(x=>x!==c); el.classList.remove('sel'); }
    else { cats.push(c); el.classList.add('sel'); }
  }
  async function submitFeedback() {
    const btn=document.getElementById('submit-btn');
    btn.disabled=true; btn.textContent='Submitting...';
    try {
      const r = await fetch('/api/showings/${req.params.showingId}/public-feedback', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ verdict, categories: cats, notes: document.getElementById('notes').value })
      });
      if (!r.ok) throw new Error('Failed');
      document.getElementById('form-wrap').style.display='none';
      document.getElementById('thanks').style.display='';
    } catch(e) { btn.disabled=false; btn.textContent='Try Again'; alert('Something went wrong. Please try again.'); }
  }
</script>
</body></html>`);
});

// Public feedback endpoint (no auth)
app.post('/api/showings/:id/public-feedback', async (req, res) => {
  try {
    const { verdict, categories = [], notes = '' } = req.body;
    if (!verdict) return res.status(400).json({ error: 'verdict required' });
    await pool.query(
      `INSERT INTO showing_feedback (showing_id, agent_id, agent_name, verdict, categories, notes, source)
       VALUES ($1, 'prospect', 'Prospect via SMS link', $2, $3, $4, 'prospect')
       ON CONFLICT (showing_id, agent_id) DO UPDATE SET
         verdict=EXCLUDED.verdict, categories=EXCLUDED.categories, notes=EXCLUDED.notes,
         source='prospect', created_at=NOW()`,
      [req.params.id, verdict, JSON.stringify(categories), notes]
    );
    broadcastToAll({ type: 'showing_feedback', showingId: req.params.id, verdict, source: 'prospect' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// In-progress showings endpoint (for bottom banner)
// Returns showing + any inbound call/sms activity from that person in last 20 min
app.get('/api/showings/in-progress', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        s.id, s.property, s.unit, s.guest_name, s.phone, s.showing_time,
        s.showing_type, s.connect_person_id,
        -- Most recent inbound activity from this person during the showing window
        act.type        AS alert_type,
        act.body        AS alert_body,
        act.created_at  AS alert_at
      FROM showings s
      LEFT JOIN LATERAL (
        SELECT a.type, a.body, a.created_at
        FROM activities a
        WHERE a.person_id::text = s.connect_person_id
          AND a.direction = 'inbound'
          AND a.created_at > NOW() - INTERVAL '20 minutes'
        ORDER BY a.created_at DESC
        LIMIT 1
      ) act ON TRUE
      WHERE s.status = 'Scheduled'
        AND s.showing_time BETWEEN NOW() - INTERVAL '15 minutes' AND NOW()
      ORDER BY act.created_at DESC NULLS LAST, s.showing_time ASC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Background poller — texts leads 15 min after showing
async function pollShowingFollowups() {
  try {
    const twilio = initTwilioFull() || initTwilio();
    if (!twilio) return;
    const fromNum = process.env.TWILIO_RESIDENT_NUMBER || '+14052562614';
    const appUrl = process.env.APP_URL || 'https://connect.okcreal.com';
    // Find completed showings from last 2 min window (14-16 min after start) not yet texted
    const { rows } = await pool.query(`
      SELECT id, guest_name, phone, property
      FROM showings
      WHERE status = 'Scheduled'
        AND phone IS NOT NULL
        AND feedback_sent = FALSE
        AND showing_time BETWEEN NOW() - INTERVAL '16 minutes' AND NOW() - INTERVAL '14 minutes'
    `);
    for (const s of rows) {
      try {
        const phone = s.phone.replace(/\D/g,'').replace(/^1/,'');
        if (phone.length !== 10) continue;
        const link = `${appUrl}/feedback/${s.id}`;
        const firstName = (s.guest_name||'').split(',')[1]?.trim().split(' ')[0] || (s.guest_name||'').split(' ')[0] || 'there';
        const msg = `Hi ${firstName}! Thanks so much for touring ${(s.property||'').split(' - ')[0]} — we're excited to hear how it went! Your feedback helps us improve the experience for everyone: ${link}`;
        await twilio.messages.create({ body: msg, from: fromNum, to: `+1${phone}` });
        await pool.query(`UPDATE showings SET feedback_sent=TRUE WHERE id=$1`, [s.id]);
        console.log(`[Showings] Feedback text sent to ${firstName} (showing ${s.id})`);
      } catch(e) { console.error('[Showings] Text error:', e.message); }
    }
  } catch(e) { console.error('[Showings Poller]', e.message); }
}

// =============================================================================
// RENT ROLL API
// =============================================================================

// Upload rent roll (browser-parsed JSON)
app.post('/api/rent-roll/upload', auth, async (req, res) => {
  try {
    const { rows, filename } = req.body;
    if (!rows || !Array.isArray(rows) || !rows.length)
      return res.status(400).json({ error: 'No rows provided' });

    const batchId = crypto.randomUUID();
    let upserted = 0;
    for (const r of rows) {
      if (!r.property || !r.unit) continue;
      const toDate = v => v ? new Date(v) : null;
      await pool.query(
        `INSERT INTO rent_roll
           (property,unit,tenant_name,status,bedrooms,sqft,market_rent,rent,deposit,
            lease_from,lease_to,move_in,move_out,past_due,nsf_count,late_count,upload_batch,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
         ON CONFLICT (property,unit) DO UPDATE SET
           tenant_name=EXCLUDED.tenant_name, status=EXCLUDED.status,
           bedrooms=EXCLUDED.bedrooms, sqft=EXCLUDED.sqft,
           market_rent=EXCLUDED.market_rent, rent=EXCLUDED.rent, deposit=EXCLUDED.deposit,
           lease_from=EXCLUDED.lease_from, lease_to=EXCLUDED.lease_to,
           move_in=EXCLUDED.move_in, move_out=EXCLUDED.move_out,
           past_due=EXCLUDED.past_due, nsf_count=EXCLUDED.nsf_count,
           late_count=EXCLUDED.late_count, upload_batch=EXCLUDED.upload_batch,
           updated_at=NOW()`,
        [ r.property, r.unit, r.tenant_name||null, r.status||null, r.bedrooms||null,
          r.sqft||null, r.market_rent||null, r.rent||null, r.deposit||null,
          toDate(r.lease_from), toDate(r.lease_to), toDate(r.move_in), toDate(r.move_out),
          r.past_due||0, r.nsf_count||0, r.late_count||0, batchId ]
      );
      upserted++;
    }
    const uploader = req.agent?.name || req.agent?.id || null;
    await pool.query(
      `INSERT INTO rent_roll_uploads (filename,uploaded_by,unit_count) VALUES ($1,$2,$3)`,
      [filename||'rent_roll.xlsx', uploader, upserted]
    );
    broadcastToAll({ type: 'rent_roll_updated', unitCount: upserted });
    res.json({ ok: true, upserted });
  } catch(e) { console.error('[Rent Roll Upload]', e.message); res.status(500).json({ error: e.message }); }
});

// Last upload timestamp
app.get('/api/rent-roll/last-upload', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT filename, uploaded_by, unit_count, created_at FROM rent_roll_uploads ORDER BY created_at DESC LIMIT 1`
    );
    res.json(rows[0] || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Rent roll status for all units of a property (for showings view)
app.get('/api/rent-roll/by-property', auth, async (req, res) => {
  try {
    const { property } = req.query;
    if (!property) return res.status(400).json({ error: 'property required' });
    const { rows } = await pool.query(
      `SELECT unit, tenant_name, status, rent, market_rent, lease_from, lease_to, move_in, late_count, past_due
       FROM rent_roll WHERE property = $1 ORDER BY unit`,
      [property]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Rent info for a specific person (for contact record)
// Matches by tenant name (last, first format) or fuzzy
app.get('/api/rent-roll/by-person', auth, async (req, res) => {
  try {
    const { name, personId } = req.query;
    if (!name) return res.json(null);
    // Try exact match first, then fuzzy
    const clean = name.toLowerCase().trim();
    const { rows } = await pool.query(
      `SELECT rr.*, rr.property, rr.unit
       FROM rent_roll rr
       WHERE LOWER(REPLACE(tenant_name, '  ', ' ')) LIKE $1
          OR LOWER(REVERSE(SPLIT_PART(REVERSE(LOWER(tenant_name)), ' ', 1)) || ' ' || TRIM(LEADING FROM REPLACE(LOWER(tenant_name), REVERSE(SPLIT_PART(REVERSE(LOWER(tenant_name)), ' ', 1)), ''))) LIKE $1
       LIMIT 3`,
      ['%' + clean.split(' ').filter(Boolean).join('%') + '%']
    );
    res.json(rows[0] || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Occupancy summary per property (for showings tab)
app.get('/api/rent-roll/occupancy', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT property,
        COUNT(*) FILTER (WHERE status='Current')::int            AS occupied,
        COUNT(*) FILTER (WHERE status LIKE 'Vacant%')::int       AS vacant,
        COUNT(*) FILTER (WHERE status LIKE 'Notice%')::int       AS on_notice,
        COUNT(*)::int                                             AS total_units,
        MIN(updated_at)                                           AS last_updated
      FROM rent_roll
      GROUP BY property
      ORDER BY property
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// GALAXY MAP — unit-level rent roll data for live space visualization
// =============================================================================
app.get('/api/dashboard/galaxy', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        property,
        json_agg(json_build_object(
          'unit', unit,
          'status', status,
          'past_due', COALESCE(past_due, 0),
          'tenant_name', tenant_name,
          'rent', rent
        ) ORDER BY unit) AS units,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status='Current' AND COALESCE(past_due,0) <= 0)::int AS occupied,
        COUNT(*) FILTER (WHERE status='Current' AND COALESCE(past_due,0) > 0)::int  AS delinquent,
        COUNT(*) FILTER (WHERE status LIKE 'Vacant%' OR status LIKE 'Notice%')::int AS vacant,
        SUM(COALESCE(past_due,0))::numeric AS total_past_due,
        updated_at
      FROM rent_roll
      WHERE property NOT ILIKE '%accounting%'
      GROUP BY property, updated_at
      ORDER BY COUNT(*) DESC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// WORK ORDERS API
// =============================================================================

app.post('/api/work-orders/upload', auth, async (req, res) => {
  try {
    const { rows, filename } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'No rows provided' });
    const batchId = crypto.randomUUID();
    let inserted = 0, skipped = 0;
    for (const r of rows) {
      if (!r.wo_number && !r.job_description) { skipped++; continue; }
      try {
        await pool.query(
          `INSERT INTO work_orders
             (property, wo_number, priority, wo_type, job_description, status,
              vendor, unit, resident, created_at, scheduled_start, completed_on,
              amount, upload_batch)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (wo_number) DO UPDATE SET
             status=EXCLUDED.status, vendor=EXCLUDED.vendor,
             scheduled_start=EXCLUDED.scheduled_start,
             completed_on=EXCLUDED.completed_on,
             amount=EXCLUDED.amount, upload_batch=EXCLUDED.upload_batch`,
          [ r.property||null, r.wo_number||null, r.priority||null, r.wo_type||null,
            r.job_description||null, r.status||null, r.vendor||null,
            r.unit||null, r.resident||null,
            r.created_at ? new Date(r.created_at) : null,
            r.scheduled_start ? new Date(r.scheduled_start) : null,
            r.completed_on ? new Date(r.completed_on) : null,
            r.amount ? parseFloat(r.amount) : null, batchId ]
        );
        inserted++;
      } catch(e) { console.warn('[WO Upload] skip:', e.message); skipped++; }
    }
    const uploader = req.agent?.name || req.agent?.id || null;
    await pool.query(`INSERT INTO work_order_uploads (filename,uploaded_by,record_count) VALUES ($1,$2,$3)`,
      [filename||'work_orders.xlsx', uploader, inserted]);
    res.json({ ok:true, inserted, skipped, batchId });
  } catch(e) { console.error('[WO Upload]', e.message); res.status(500).json({ error: e.message }); }
});

app.get('/api/work-orders/last-upload', auth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT filename, uploaded_by, record_count, created_at FROM work_order_uploads ORDER BY created_at DESC LIMIT 1`);
    res.json(r.rows[0] || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/work-orders/stats', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH monthly AS (
        SELECT property,
               DATE_TRUNC('month', created_at) AS month,
               COUNT(*)::int                   AS cnt
        FROM work_orders
        WHERE created_at > NOW() - INTERVAL '6 months'
        GROUP BY property, DATE_TRUNC('month', created_at)
      ),
      avg3 AS (
        SELECT property,
               ROUND(AVG(cnt),1) AS avg_monthly,
               MAX(CASE WHEN month = DATE_TRUNC('month', NOW()) THEN cnt END) AS this_month,
               MAX(CASE WHEN month = DATE_TRUNC('month', NOW() - INTERVAL '1 month') THEN cnt END) AS last_month,
               MAX(CASE WHEN month = DATE_TRUNC('month', NOW() - INTERVAL '2 months') THEN cnt END) AS month2_ago
        FROM monthly GROUP BY property
      )
      SELECT property,
             COALESCE(this_month,0)  AS this_month,
             COALESCE(last_month,0)  AS last_month,
             COALESCE(month2_ago,0)  AS month2_ago,
             COALESCE(avg_monthly,0) AS avg_monthly
      FROM avg3
      WHERE COALESCE(this_month,0) + COALESCE(last_month,0) + COALESCE(month2_ago,0) > 0
      ORDER BY COALESCE(this_month,0) DESC LIMIT 12
    `);
    const open = await pool.query(`
      SELECT priority, COUNT(*)::int AS cnt FROM work_orders
      WHERE status NOT IN ('Completed','Cancelled','Canceled')
      GROUP BY priority
    `);
    res.json({ byProperty: rows, openByPriority: open.rows });
  } catch(e) { console.error('[WO Stats]', e.message); res.status(500).json({ error: e.message }); }
});

// =============================================================================
// DASHBOARD — mission control stats
// =============================================================================
app.get('/api/dashboard/stats', auth, async (req, res) => {
  try {
    // Who is online (has active SSE connection)
    const onlineIds = Array.from(agentConnections.keys());

    // All agents with online flag
    const agentsR = await pool.query(`
      SELECT id, name, email, role, avatar_color, avatar_b64, availability
      FROM agents WHERE is_active=true ORDER BY name
    `);
    const agents = agentsR.rows.map(a => ({
      ...a,
      online: onlineIds.includes(String(a.id))
    }));

    // Call stats today
    const callsToday = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE direction='inbound')::int              AS inbound_total,
        COUNT(*) FILTER (WHERE direction='outbound')::int             AS outbound_total,
        COUNT(*) FILTER (WHERE direction='inbound' AND status='completed')::int  AS inbound_answered,
        COUNT(*) FILTER (WHERE direction='inbound' AND status IN ('no-answer','busy','canceled','missed'))::int AS missed,
        ROUND(AVG(duration_seconds) FILTER (WHERE status='completed'))::int AS avg_duration,
        COUNT(*) FILTER (WHERE direction='inbound' AND status='completed' AND duration_seconds >= 60)::int AS qualified_calls
      FROM calls
      WHERE started_at > NOW() - INTERVAL '24 hours'
    `);
    const ct = callsToday.rows[0];

    // Call stats last 7 days per agent
    const agentCallStats = await pool.query(`
      SELECT
        c.agent_id,
        a.name AS agent_name,
        a.avatar_color,
        COUNT(*) FILTER (WHERE c.direction='inbound' AND c.status='completed')::int  AS inbound_answered,
        COUNT(*) FILTER (WHERE c.direction='outbound' AND c.status='completed')::int AS outbound_made,
        COUNT(*) FILTER (WHERE c.status='completed')::int AS total_calls,
        ROUND(AVG(c.duration_seconds) FILTER (WHERE c.status='completed'))::int      AS avg_duration
      FROM calls c
      JOIN agents a ON a.id::text = c.agent_id
      WHERE c.started_at > NOW() - INTERVAL '7 days'
      GROUP BY c.agent_id, a.name, a.avatar_color
      ORDER BY total_calls DESC
    `);

    // Lead response time — time from lead created to first outbound call/sms, business hours only
    const responseTime = await pool.query(`
      SELECT
        ROUND(AVG(EXTRACT(EPOCH FROM (first_contact - p.created_at))/60))::int AS avg_minutes,
        COUNT(*)::int AS sample_size,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (first_contact - p.created_at)) <= 300)::int AS under_5min,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (first_contact - p.created_at)) BETWEEN 300 AND 3600)::int AS under_1hr,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (first_contact - p.created_at)) > 3600)::int AS over_1hr
      FROM people p
      JOIN (
        SELECT person_id, MIN(created_at) AS first_contact
        FROM activities
        WHERE direction='outbound' AND type IN ('call','sms')
          AND EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Chicago') BETWEEN 8 AND 19
        GROUP BY person_id
      ) fc ON fc.person_id::text = p.id::text
      WHERE p.created_at > NOW() - INTERVAL '30 days'
        AND EXTRACT(HOUR FROM p.created_at AT TIME ZONE 'America/Chicago') BETWEEN 8 AND 19
        AND first_contact > p.created_at
    `);
    const rt = responseTime.rows[0];

    // Upload freshness
    const [showingUpload, rrUpload, woUpload] = await Promise.all([
      pool.query(`SELECT created_at, record_count FROM showing_uploads ORDER BY created_at DESC LIMIT 1`),
      pool.query(`SELECT created_at, unit_count FROM rent_roll_uploads ORDER BY created_at DESC LIMIT 1`),
      pool.query(`SELECT created_at, record_count FROM work_order_uploads ORDER BY created_at DESC LIMIT 1`)
    ]);

    // SMS stats today
    const smsToday = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE direction='outbound')::int AS sent,
        COUNT(*) FILTER (WHERE direction='inbound')::int  AS received,
        COUNT(*) FILTER (WHERE sms_status='failed')::int  AS failed
      FROM activities
      WHERE type='sms' AND created_at > NOW() - INTERVAL '24 hours'
    `);

    res.json({
      agents,
      onlineCount: onlineIds.length,
      calls: ct,
      agentCallStats: agentCallStats.rows,
      responseTime: rt,
      sms: smsToday.rows[0],
      uploads: {
        showings: showingUpload.rows[0] || null,
        rentRoll: rrUpload.rows[0] || null,
        workOrders: woUpload.rows[0] || null
      }
    });
  } catch(e) {
    console.error('[Dashboard]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// SPA CATCH-ALL — serve index.html for /file/:id, /inbox, /admin, etc.
// =============================================================================
// SPA CATCH-ALL — must be AFTER all API routes
// Serves index.html for every frontend path: /dashboard, /showings, /inbox, etc.
// =============================================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// =============================================================================
// START
// =============================================================================
// ── Verify DB connectivity before running migrations ──
async function checkDB() {
  try {
    await pool.query('SELECT 1');
    console.log('✅ Database connected');
  } catch(e) {
    console.error('❌ FATAL: Cannot connect to database:', e.message);
    console.error('   Check DATABASE_URL in Railway environment variables.');
    process.exit(1);
  }
}

checkDB().then(() => initDB()).then(() => {
  // Showing followup text poller — runs every 2 minutes
  setInterval(pollShowingFollowups, 2 * 60 * 1000);
  setTimeout(pollShowingFollowups, 10000); // first check 10s after boot

  app.listen(PORT, () => {
    console.log(`OKCREAL Connect running on port ${PORT}`);
    console.log(`Twilio Account:  ${process.env.TWILIO_ACCOUNT_SID ? '✓' : '✗'}`);
    console.log(`Twilio API Key:  ${process.env.TWILIO_API_KEY_SID ? '✓' : '✗'}`);
    console.log(`Twilio Auth Tok: ${process.env.TWILIO_AUTH_TOKEN ? '✓' : '✗ (not needed if API Key set)'}`);
    console.log(`Twilio RecAuth:  ${twilioBasicAuth() ? '✓ ready' : '✗ NO CREDENTIALS - recordings will fail'}`);
    console.log(`Deepgram: ${process.env.DEEPGRAM_API_KEY ? '✓' : '✗'}`);
    console.log(`Grok:     ${process.env.GROK_API_KEY ? '✓' : '✗'}`);
  });
}); // end checkDB().then(() => initDB()).then
