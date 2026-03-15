require('dotenv').config();
const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const multer  = require('multer');
const crypto  = require('crypto');
const { google } = require('googleapis');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initWorkOrderAlerts } = require('./work-order-alerts');

const app = express();
const httpServer = http.createServer(app);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

// ── Global crash guards — prevent silent process death on unhandled async errors ──
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Promise Rejection:', reason?.stack || reason);
  // Log but do NOT exit — keeps the server alive for other requests
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err?.stack || err);
  // Restart via Railway/PM2 rather than hanging in a broken state
  process.exit(1);
});

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
  // Accept token from Authorization header OR ?token= query param (needed for EventSource/SSE)
  const h = req.headers.authorization;
  const rawToken = h?.startsWith('Bearer ') ? h.slice(7) : (req.query.token || null);
  if (!rawToken) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(rawToken, JWT_SECRET);
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
      const q = search.trim();
      const qLower = q.toLowerCase();
      const parts = q.split(/\s+/).filter(Boolean);
      const digits = q.replace(/\D/g, '');

      // Build one comprehensive OR clause
      params.push(`%${q}%`); const pFull = params.length;

      const conditions = [];

      // ── Name: concatenated full name search (handles "Lilah Gonzalez", "Gonzalez, Lilah", partials) ──
      conditions.push(`(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')) ILIKE $${pFull}`);
      conditions.push(`(COALESCE(p.last_name,'') || ' ' || COALESCE(p.first_name,'')) ILIKE $${pFull}`);
      conditions.push(`(COALESCE(p.last_name,'') || ', ' || COALESCE(p.first_name,'')) ILIKE $${pFull}`);

      // ── Individual field partial match ──
      conditions.push(`p.first_name ILIKE $${pFull}`);
      conditions.push(`p.last_name ILIKE $${pFull}`);
      conditions.push(`p.email ILIKE $${pFull}`);

      // ── Multi-word: each word must match either first or last name ──
      if (parts.length >= 2) {
        const wordConditions = [];
        for (const word of parts) {
          params.push(`%${word}%`);
          const pw = params.length;
          wordConditions.push(`(p.first_name ILIKE $${pw} OR p.last_name ILIKE $${pw})`);
        }
        conditions.push(`(${wordConditions.join(' AND ')})`);
      }

      // ── Phone: if query has 3+ digits, search phone fields with digits-only matching ──
      if (digits.length >= 3) {
        params.push(`%${digits}%`); const pDigits = params.length;
        conditions.push(`REGEXP_REPLACE(COALESCE(p.phone,''), '\\D', '', 'g') LIKE $${pDigits}`);
        conditions.push(`EXISTS(SELECT 1 FROM person_phones pp2 WHERE pp2.person_id=p.id AND REGEXP_REPLACE(pp2.phone, '\\D', '', 'g') LIKE $${pDigits})`);
      } else {
        // Non-phone: still check raw phone/email fields
        conditions.push(`p.phone ILIKE $${pFull}`);
        conditions.push(`EXISTS(SELECT 1 FROM person_phones pp2 WHERE pp2.person_id=p.id AND pp2.phone ILIKE $${pFull})`);
      }

      // ── Rent roll: search by tenant name, unit, or property address ──
      conditions.push(`EXISTS(SELECT 1 FROM rent_roll rr WHERE rr.person_id=p.id AND (rr.tenant_name ILIKE $${pFull} OR rr.unit ILIKE $${pFull} OR rr.property ILIKE $${pFull}))`);

      // ── Background / notes ──
      conditions.push(`p.background ILIKE $${pFull}`);

      where.push(`(${conditions.join(' OR ')})`);
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
              AND s.showing_time BETWEEN NOW() - INTERVAL '2 hours' AND NOW() + INTERVAL '14 days'
              AND LOWER(s.status) = 'scheduled'
            -- grab property/unit from the soonest showing
            JOIN LATERAL (
              SELECT property, unit, showing_type FROM showings
              WHERE connect_person_id = p.id::text
                AND showing_time BETWEEN NOW() - INTERVAL '2 hours' AND NOW() + INTERVAL '14 days'
                AND LOWER(status) = 'scheduled'
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
        // ── SPECIAL: Toured — No Follow-Up ──────────────────────────────────
        if (f.type === 'toured_no_followup') {
          const days = parseInt(f.days_ago || 7); // default: tours in past 7 days
          const shR = await pool.query(`
            SELECT
              p.*,
              MAX(s.showing_time)                                               AS last_tour_at,
              s2.property                                                       AS showing_property,
              s2.unit                                                           AS showing_unit,
              s2.showing_type                                                   AS showing_type,
              MAX(a.created_at) FILTER (WHERE a.direction='outbound'
                AND a.created_at > s2.last_tour)                               AS followup_at,
              MAX(a.created_at) FILTER (WHERE a.direction='inbound')           AS last_inbound_at,
              COUNT(s.id)::int                                                  AS tour_count
            FROM people p
            JOIN showings s ON s.connect_person_id = p.id::text
              AND s.showing_time < NOW()
              AND s.showing_time > NOW() - INTERVAL '1 day' * $1
              AND s.status = 'Completed'
            -- grab details of the most recent completed tour
            JOIN LATERAL (
              SELECT property, unit, showing_type, showing_time AS last_tour
              FROM showings
              WHERE connect_person_id = p.id::text
                AND status = 'Completed'
                AND showing_time < NOW()
              ORDER BY showing_time DESC LIMIT 1
            ) s2 ON TRUE
            LEFT JOIN activities a ON a.person_id::text = p.id::text
            GROUP BY p.id, s2.property, s2.unit, s2.showing_type, s2.last_tour
            -- only people with NO outbound activity after their last tour
            HAVING MAX(a.created_at) FILTER (
              WHERE a.direction='outbound' AND a.created_at > s2.last_tour
            ) IS NULL
            ORDER BY MAX(s.showing_time) DESC
          `, [days]);
          const people = shR.rows.map(p => ({
            ...p, ...(p.custom_fields || {}),
            needs_contact: true
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

      // Enrich with rent roll data (unit + property) when available
      if (search) {
        const rrR = await pool.query(
          `SELECT person_id, unit, property, tenant_name, status FROM rent_roll WHERE person_id = ANY($1) AND status = 'Current'`,
          [ids]
        );
        const rrMap = {};
        rrR.rows.forEach(row => { if (!rrMap[row.person_id]) rrMap[row.person_id] = row; });
        r.rows.forEach(p => {
          const rr = rrMap[p.id];
          if (rr) { p.rr_unit = rr.unit; p.rr_property = rr.property; p.rr_tenant = rr.tenant_name; }
        });
      }
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
             dv_victim, dv_notes, dob, ssn, is_military, appfolio_unit, appfolio_property,
             created_at, updated_at
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
    const { firstName, lastName, phone, email, stage, source, background, tags, customFields, assignedTo, address, city, state, zip, dob, ssn, isMilitary } = req.body;
    const r = await pool.query(
      `UPDATE people SET
        first_name=COALESCE($1,first_name), last_name=COALESCE($2,last_name),
        phone=COALESCE($3,phone), email=COALESCE($4,email),
        stage=COALESCE($5,stage), source=COALESCE($6,source),
        background=COALESCE($7,background), tags=COALESCE($8,tags),
        custom_fields=custom_fields||COALESCE($9::jsonb,'{}'),
        address=COALESCE($10,address), city=COALESCE($11,city),
        state=COALESCE($12,state), zip=COALESCE($13,zip),
        dob=COALESCE($15::date,dob), ssn=COALESCE($16,ssn),
        is_military=COALESCE($17,is_military),
        updated_at=NOW()
       WHERE id=$14 RETURNING *`,
      [firstName||null, lastName||null, phone||null, email||null, stage||null,
       source||null, background||null, tags||null,
       customFields ? JSON.stringify(customFields) : null,
       address||null, city||null, state||null, zip||null, req.params.id,
       dob||null, ssn||null, isMilitary!=null?isMilitary:null]
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

    // Async: run OCR via Grok Vision in the background
    (async () => {
      try {
        const grok = initGrok();
        if (!grok) return;
        const personR = await pool.query('SELECT first_name, last_name FROM people WHERE id=$1', [req.params.id]);
        const pName = personR.rows[0] ? `${personR.rows[0].first_name} ${personR.rows[0].last_name||''}`.trim() : 'unknown';
        console.log(`[ID OCR] Starting for ${pName}...`);

        const ocrResp = await grok.chat.completions.create({
          model: 'grok-3', max_tokens: 600,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${photoB64}` } },
              { type: 'text', text: `This is a photo of an ID document (driver's license, state ID, passport, etc). Extract ALL text fields you can read. The image may be rotated or upside down — read it regardless.

IMPORTANT: Also detect the orientation. Look at where the text reads naturally — if the text is upside down, the image needs 180° rotation. If sideways, it needs 90° or 270°.

Return ONLY a JSON object with these fields (use null for anything you can't read):
{
  "rotation_needed": 0,
  "full_legal_name": "first middle last",
  "first_name": "",
  "middle_name": "",
  "last_name": "",
  "date_of_birth": "YYYY-MM-DD",
  "address": "full street address",
  "city": "",
  "state": "",
  "zip": "",
  "id_number": "DL or ID number",
  "id_type": "drivers_license or state_id or passport or other",
  "issuing_state": "",
  "expiration_date": "YYYY-MM-DD",
  "sex": "male or female",
  "height": "",
  "eye_color": "",
  "issue_date": "YYYY-MM-DD"
}
rotation_needed: degrees clockwise needed to make the ID right-side-up (0, 90, 180, or 270).
Return ONLY the JSON, no markdown fences, no explanation.` }
            ]
          }]
        });

        const raw = ocrResp.choices[0]?.message?.content?.trim() || '';
        const clean = raw.replace(/```json|```/g, '').trim();
        let ocr;
        try { ocr = JSON.parse(clean); } catch(e) { console.warn('[ID OCR] Failed to parse:', clean.slice(0, 200)); return; }

        // Calculate age from DOB
        if (ocr.date_of_birth) {
          try {
            const dob = new Date(ocr.date_of_birth);
            ocr.age = Math.floor((Date.now() - dob.getTime()) / (365.25 * 86400000));
          } catch(e) {}
        }

        // Check if expired
        if (ocr.expiration_date) {
          try { ocr.is_expired = new Date(ocr.expiration_date) < new Date(); } catch(e) {}
        }

        ocr.ocr_date = new Date().toISOString();

        await pool.query(
          `UPDATE people SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || $1::jsonb WHERE id=$2`,
          [JSON.stringify({ id_ocr: ocr }), req.params.id]
        );
        console.log(`[ID OCR] ${pName}: ${ocr.full_legal_name || 'name not read'}, DOB: ${ocr.date_of_birth || '?'}, ${ocr.issuing_state || '?'} ${ocr.id_type || 'ID'}`);
      } catch(e) { console.warn('[ID OCR] Error:', e.message); }
    })();

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


// ─── FED WORKSHEET PDF ────────────────────────────────────────────────────────
app.post('/api/people/:id/fed-worksheet', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.*, p.dob, p.ssn, p.is_military,
             p.custom_fields->>'past_due_balance' AS past_due_balance,
             p.custom_fields->>'unit_number' AS unit_number,
             p.custom_fields->>'lease_end_date' AS lease_end_date,
             p.appfolio_property, p.appfolio_unit
      FROM people p WHERE p.id=$1
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    const p = r.rows[0];

    // ── Validate required fields ──────────────────────────────────────────────
    const missing = [];
    if (!p.first_name || !p.last_name) missing.push('Full name');
    if (!p.address)                    missing.push('Tenant address (street)');
    if (!p.city)                       missing.push('City');
    if (!p.state)                      missing.push('State');
    if (!p.zip)                        missing.push('ZIP code');
    if (!p.dob)                        missing.push('Date of birth');
    if (!p.past_due_balance && p.past_due_balance !== 0) missing.push('Past due balance (custom field)');
    if (missing.length) return res.status(422).json({ error: 'Missing required fields', missing });

    const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]); // letter
    const { width, height } = page.getSize();
    const bold   = await doc.embedFont(StandardFonts.HelveticaBold);
    const normal = await doc.embedFont(StandardFonts.Helvetica);

    const draw = (text, x, y, { font=normal, size=10, color=rgb(0,0,0) }={}) =>
      page.drawText(String(text||''), { x, y, size, font, color });

    const line = (x1, y1, x2, y2, thickness=0.5) =>
      page.drawLine({ start:{x:x1,y:y1}, end:{x:x2,y:y2}, thickness, color:rgb(0,0,0) });

    const box = (x, y, w, h, thickness=0.5) => {
      line(x,y,x+w,y,thickness); line(x,y+h,x+w,y+h,thickness);
      line(x,y,x,y+h,thickness); line(x+w,y,x+w,y+h,thickness);
    };

    const M = 54; // margin
    let y = height - M;

    // Header
    draw('GOLDMAN LAW FED WORKSHEET', M, y, { font:bold, size:13 });
    y -= 22;

    const field = (label, value, lx, ly, fw=220) => {
      draw(label, lx, ly, { size:8, color:rgb(0.4,0.4,0.4) });
      draw(value||'', lx, ly-13, { size:10 });
      line(lx, ly-15, lx+fw, ly-15, 0.5);
    };

    // Two-column layout
    field('LEGAL OWNERSHIP NAME', 'OKCREAL LLC',                    M,   y);
    field('APT. OR MANAGEMENT CO. NAME', 'OKCREAL LLC',             340, y);
    y -= 36;
    field('MANAGEMENT CO. ADDRESS', '6608 N Western Ave #1358, OKC OK 73116', M, y, 460);
    y -= 36;
    field('MANAGEMENT CO PHONE #', '405-256-2156',                  M,   y);
    field('EMAIL ADDRESS', 'Leasing@OKCREAL.com',                   340, y);
    y -= 36;

    const tenantName = `${p.first_name} ${p.last_name}`;
    const tenantAddr = `${p.address}, ${p.city}, ${p.state} ${p.zip}`;
    field('RESIDENT(S) NAME', tenantName + ' and all occupants',    M,   y, 460);
    y -= 36;
    field('ADDRESS OF RESIDENT', tenantAddr,                        M,   y, 300);
    field('COUNTY', p.city || 'Oklahoma',                           380, y, 170);
    y -= 36;

    const dobStr = p.dob ? new Date(p.dob).toLocaleDateString('en-US') : '';
    const ssnStr = p.ssn ? `***-**-${String(p.ssn).slice(-4)}` : 'Not on file';
    field('DATE OF BIRTH', dobStr,                                  M,   y);
    field('RESIDENT SSN (last 4)', ssnStr,                          230, y);
    field('MILITARY?', p.is_military ? 'YES' : 'NO',               400, y, 100);
    y -= 36;

    // Base rent + months owed
    const balance = parseFloat(p.past_due_balance || 0);
    const noticeDate = req.body.noticeDate || new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
    field('BASE RENT', `$${balance.toFixed(2)}`,                    M,   y);
    field('SERVICE DATE OF NOTICE', noticeDate,                     340, y);
    y -= 36;
    field('HOW SERVED', req.body.howServed || 'Posted and mailed certified', M, y, 460);
    y -= 36;

    // Divider
    draw('(pro-ration to be completed by attorney)', M, y, { size:8, color:rgb(0.5,0.5,0.5) });
    y -= 20;
    line(M, y, width-M, y, 1);
    y -= 16;
    draw('— Do not fill out below —', width/2 - 55, y, { size:8, color:rgb(0.5,0.5,0.5) });
    y -= 20;

    field('SUB-TOTAL $', '',        M,    y);
    field('LATE FEE $', '',         200,  y);
    field('TOTAL DUE $', '',        340,  y);
    field('ATTY FEE (10%) $', '',   460,  y, 96);
    y -= 36;
    field('COURT DATE & JUDGE', '', M,    y, 460);

    // Footer
    y = 40;
    draw('Generated by OKCREAL Connect · ' + new Date().toLocaleDateString(), M, y, { size:8, color:rgb(0.6,0.6,0.6) });

    const pdfBytes = await doc.save();
    const filename = `FED_Worksheet_${p.last_name}_${Date.now()}.pdf`;
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
    res.end(Buffer.from(pdfBytes));

    // Log activity
    await pool.query(
      `INSERT INTO activities (person_id,agent_id,type,body,direction) VALUES ($1,$2,'note',$3,'internal')`,
      [req.params.id, req.agent?.id||null, '📋 FED Worksheet generated and downloaded']
    );
  } catch(e) {
    console.error('[FED worksheet]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── 5-DAY NOTICE TO QUIT PDF ─────────────────────────────────────────────────
app.post('/api/people/:id/five-day-notice', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.*,
             p.custom_fields->>'past_due_balance' AS past_due_balance,
             p.custom_fields->>'unit_number' AS unit_number,
             p.appfolio_property, p.appfolio_unit
      FROM people p WHERE p.id=$1
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    const p = r.rows[0];

    const missing = [];
    if (!p.first_name || !p.last_name) missing.push('Full name');
    if (!p.address)                    missing.push('Tenant address');
    if (!p.city || !p.state)           missing.push('City / State');
    if (!p.past_due_balance && p.past_due_balance !== 0) missing.push('Past due balance');
    if (missing.length) return res.status(422).json({ error: 'Missing required fields', missing });

    const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
    const balance  = parseFloat(p.past_due_balance || 0);
    const postingFee = 25;
    const totalDue   = balance + postingFee;

    const today    = new Date();
    const dueDate  = new Date(today); dueDate.setDate(today.getDate() + 5);
    const fmtDate  = d => d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
    const fmtShort = d => d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
    const tenantName = `${p.first_name} ${p.last_name}`;
    const unitNum    = p.appfolio_unit || p.unit_number || req.body.unit || '';
    const property   = p.appfolio_property || req.body.property || 'OKCREAL Property';
    const propAddr   = `${p.address}, ${p.city}, ${p.state} ${p.zip||''}`.trim();

    // ── PAGE 1: Five-Day Notice ───────────────────────────────────────────────
    const doc  = await PDFDocument.create();
    const addPage = () => {
      const pg = doc.addPage([612, 792]);
      return pg;
    };

    const embedFonts = async () => ({
      bold:   await doc.embedFont(StandardFonts.HelveticaBold),
      normal: await doc.embedFont(StandardFonts.Helvetica),
      oblique:await doc.embedFont(StandardFonts.HelveticaOblique),
    });
    const F = await embedFonts();

    const txt = (pg, text, x, y, opts={}) => pg.drawText(String(text||''), {
      x, y, size: opts.size||10, font: opts.font||F.normal, color: opts.color||rgb(0,0,0)
    });
    const ln = (pg, x1,y1,x2,y2, t=0.5) => pg.drawLine({
      start:{x:x1,y:y1},end:{x:x2,y:y2},thickness:t,color:rgb(0,0,0)
    });
    const rect = (pg, x,y,w,h,fill,stroke) => {
      pg.drawRectangle({x,y,width:w,height:h,
        color:fill||undefined, borderColor:stroke||rgb(0,0,0), borderWidth:0.5});
    };

    // ── Notice page ───────────────────────────────────────────────────────────
    const pg1 = addPage();
    const M = 54, W = 612-M*2;
    let y = 738;

    // Header bar
    rect(pg1, M, y-2, W, 28, rgb(0.05,0.05,0.05));
    txt(pg1, 'OKCREAL PROPERTY MANAGEMENT', M+8, y+6, { font:F.bold, size:13, color:rgb(1,1,1) });
    y -= 36;
    txt(pg1, 'FIVE-DAY NOTICE TO PAY RENT OR QUIT', M, y, { font:F.bold, size:14 });
    y -= 14;
    txt(pg1, 'Pursuant to Oklahoma Statutes Title 41, Section 131(B)', M, y, { size:9, color:rgb(0.4,0.4,0.4), font:F.oblique });
    y -= 24;
    ln(pg1, M, y, M+W, y, 1);
    y -= 16;

    // Four-cell info grid
    const cell = (label, value, x, cy, w=240) => {
      txt(pg1, label, x, cy, { size:8, color:rgb(0.5,0.5,0.5), font:F.bold });
      txt(pg1, value, x, cy-14, { size:10 });
    };
    cell('TO (TENANT)',     tenantName + (unitNum?`\nUnit ${unitNum}`:''),     M,   y);
    cell('FROM (LANDLORD)', 'OKCREAL Property Management\n405-256-1696',       360, y);
    y -= 42;
    cell('DATE OF NOTICE',  fmtDate(today),                                   M,   y);
    cell('PROPERTY ADDRESS', propAddr,                                         360, y);
    y -= 42;
    ln(pg1, M, y, M+W, y, 0.5);
    y -= 20;

    // Amount box
    rect(pg1, M, y-70, W, 80, rgb(0.97,0.97,0.97));
    txt(pg1, 'AMOUNT REQUIRED TO CURE DEFAULT:', M+8, y-4, { font:F.bold, size:11 });
    txt(pg1, `Unpaid rent (as of ${fmtDate(today)}):`, M+16, y-22, { size:10 });
    txt(pg1, `$${balance.toFixed(2)}`, M+W-80, y-22, { font:F.bold, size:10 });
    txt(pg1, 'Door posting administrative fee:', M+16, y-38, { size:10 });
    txt(pg1, `$${postingFee.toFixed(2)}`, M+W-80, y-38, { size:10 });
    ln(pg1, M+W-120, y-46, M+W-8, y-46, 0.5);
    txt(pg1, 'TOTAL DUE:', M+16, y-58, { font:F.bold, size:11 });
    txt(pg1, `$${totalDue.toFixed(2)}`, M+W-80, y-58, { font:F.bold, size:11, color:rgb(0.85,0,0.1) });
    y -= 96;

    // Notice body
    const wrap = (pg, text, x, startY, maxW, lineH=14, opts={}) => {
      const words = text.split(' ');
      const sz = opts.size||10;
      const fn = opts.font||F.normal;
      let line2 = ''; let cy = startY;
      for (const w of words) {
        const test = line2 ? line2+' '+w : w;
        const tw = fn.widthOfTextAtSize(test, sz);
        if (tw > maxW && line2) {
          txt(pg, line2, x, cy, opts);
          line2 = w; cy -= lineH;
        } else line2 = test;
      }
      if (line2) { txt(pg, line2, x, cy, opts); cy -= lineH; }
      return cy;
    };

    const body = `YOU ARE HEREBY NOTIFIED that you are in default in the payment of rent for the above-described premises in the amount of $${balance.toFixed(2)}, which is now due and owing. You are hereby DEMANDED to pay said rent in full within FIVE (5) DAYS from the date of service of this notice (on or before ${fmtShort(dueDate)}), or to vacate and surrender possession of the premises. Failure to do so will result in commencement of legal proceedings for recovery of possession, all rent due, and other damages as permitted by Oklahoma law.`;
    y = wrap(pg1, body, M, y, W, 15, { size:10 });
    y -= 20;

    // Personal message box
    rect(pg1, M, y-88, W, 98, rgb(0.96,0.98,0.97));
    txt(pg1, 'A PERSONAL MESSAGE FROM OKCREAL:', M+8, y-6, { font:F.bold, size:10 });
    const msg = `${p.first_name}, we want you to know that filing for eviction is a last resort — it is never our goal. We value your tenancy and genuinely want to help you stay in your home. This notice is a legal requirement we must serve, but it does not mean the situation is beyond repair. If you are experiencing a hardship or need to discuss a payment arrangement, please contact us immediately at 405-256-1696 or text us any time. Payment can be made online at teamokcreal.appfolio.com or in cash using your Pay Near Me barcode at CVS or 7-Eleven. Every day counts — please reach out today.`;
    wrap(pg1, msg, M+8, y-22, W-16, 13, { size:9, font:F.normal, color:rgb(0.2,0.2,0.2) });
    y -= 112;

    // Deadline callout
    txt(pg1, `\u25A0 PAYMENT DEADLINE: ${fmtShort(dueDate)} \u25A0`, M+W/2-120, y, { font:F.bold, size:11 });
    y -= 28;
    ln(pg1, M, y, M+180, y, 0.5);
    txt(pg1, 'Authorized Representative, OKCREAL Property Management', M, y-14, { size:9, color:rgb(0.4,0.4,0.4) });

    // ── PAGE 2: Proof of Service ──────────────────────────────────────────────
    const pg2 = addPage();
    y = 738;
    rect(pg2, M, y-2, W, 28, rgb(0.05,0.05,0.05));
    txt(pg2, 'OKCREAL PROPERTY MANAGEMENT', M+8, y+6, { font:F.bold, size:13, color:rgb(1,1,1) });
    y -= 48;
    txt(pg2, 'PROOF OF SERVICE', M, y, { font:F.bold, size:14 });
    y -= 14;
    txt(pg2, 'TO BE COMPLETED BY LEASING OFFICER', M, y, { size:9, font:F.oblique, color:rgb(0.4,0.4,0.4) });
    y -= 24;
    ln(pg2, M, y, M+W, y, 1);
    y -= 18;
    txt(pg2, `Served on: ${tenantName}${unitNum?' | Unit '+unitNum:''} | ${property}`, M, y, { font:F.bold, size:11 });
    y -= 28;
    ln(pg2, M, y, M+W, y, 0.5);

    // Option A
    y -= 20;
    rect(pg2, M, y-3, 10, 10);
    txt(pg2, 'OPTION A \u2014 Personal Service', M+16, y, { font:F.bold, size:11 });
    y -= 16;
    txt(pg2, 'Notice was handed directly to the tenant on the date stated. Tenant signature below (or write "Refused"):', M+8, y, { size:9 });
    y -= 22;
    txt(pg2, 'Tenant Signature:', M+8, y, { size:9 });
    ln(pg2, M+90, y-2, M+W-100, y-2, 0.5);
    txt(pg2, 'Date/Time:', M+W-98, y, { size:9 });
    ln(pg2, M+W-50, y-2, M+W, y-2, 0.5);
    y -= 28;
    ln(pg2, M, y, M+W, y, 0.3);

    // Option B
    y -= 20;
    rect(pg2, M, y-3, 10, 10);
    txt(pg2, 'OPTION B \u2014 Door Posting (Certified Mail Required)', M+16, y, { font:F.bold, size:11 });
    y -= 16;
    txt(pg2, 'Notice posted on primary entry door. Date-stamped photo taken. Certified mail copy to be sent upon return to office.', M+8, y, { size:9 });
    y -= 22;
    txt(pg2, 'Officer Initials:', M+8, y, { size:9 });
    ln(pg2, M+80, y-2, M+160, y-2, 0.5);
    txt(pg2, 'Date/Time Posted:', M+170, y, { size:9 });
    ln(pg2, M+255, y-2, M+360, y-2, 0.5);
    txt(pg2, 'Cert. Mail #:', M+370, y, { size:9 });
    ln(pg2, M+430, y-2, M+W, y-2, 0.5);
    y -= 40;
    ln(pg2, M, y, M+W, y, 0.5);
    y -= 16;
    wrap(pg2, 'This notice is served pursuant to Oklahoma Statutes Title 41, \u00A7 131(B). Demand for past due rent is deemed a demand for possession of the premises. The door posting fee is an administrative charge separate from the rent demand and does not constitute rent under Oklahoma law. Personal service is complete upon delivery to the tenant. Door posting service requires follow-up certified mailing.', M, y, W, 13, { size:8, color:rgb(0.45,0.45,0.45) });

    const pdfBytes = await doc.save();
    const safeName = p.last_name.replace(/[^a-zA-Z0-9]/g,'_');
    const filename = `5Day_Notice_${safeName}_${Date.now()}.pdf`;
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
    res.end(Buffer.from(pdfBytes));

    await pool.query(
      `INSERT INTO activities (person_id,agent_id,type,body,direction) VALUES ($1,$2,'note',$3,'internal')`,
      [req.params.id, req.agent?.id||null, `📄 5-Day Notice generated — $${totalDue.toFixed(2)} total due, deadline ${fmtShort(dueDate)}`]
    );
  } catch(e) {
    console.error('[5-day notice]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── TENANT DIRECTORY IMPORT (AppFolio xlsx sync) ────────────────────────────
app.post('/api/import/tenant-directory', auth, async (req, res) => {
  try {
    const { rows } = req.body; // [{name,email,phone,property,unit,moveIn,leaseTo,rent,dob,status}]
    if (!rows?.length) return res.status(400).json({ error: 'No rows provided' });

    let updated = 0, notFound = 0;
    const notFoundList = [];

    for (const row of rows) {
      // Try to match by email first, then by name
      let match = null;
      if (row.email) {
        const r = await pool.query(
          `SELECT id FROM people WHERE LOWER(email)=LOWER($1) LIMIT 1`, [row.email]
        );
        match = r.rows[0];
      }
      if (!match && row.name) {
        // AppFolio: 'A. Last, First' or 'Last, First' — strip leading initial prefix
        const cleanName = row.name.replace(/^[A-Z]\. /, '');
        let last, first;
        if (cleanName.includes(',')) {
          last  = cleanName.split(',')[0].trim();
          first = cleanName.split(',').slice(1).join(',').trim().split(' ')[0];
        } else {
          const np = cleanName.trim().split(' ');
          last = np[np.length-1]; first = np[0];
        }
        const r = await pool.query(
          `SELECT id FROM people WHERE LOWER(first_name) ILIKE $1 AND LOWER(last_name) ILIKE $2 LIMIT 1`,
          [`%${first.toLowerCase()}%`, `%${last.toLowerCase()}%`]
        );
        match = r.rows[0];
      }

      if (!match) {
        notFound++;
        notFoundList.push(row.name);
        continue;
      }

      const updates = {};
      const params = [];
      const sets = [];
      let idx = 1;

      if (row.dob)       { sets.push(`dob=$${idx++}::date`);             params.push(row.dob); }
      if (row.unit)      { sets.push(`appfolio_unit=$${idx++}`);          params.push(row.unit); }
      if (row.property)  { sets.push(`appfolio_property=$${idx++}`);      params.push(row.property); }
      if (row.phone)     { sets.push(`phone=COALESCE(phone,$${idx++})`);  params.push(row.phone); }

      // Merge rent + lease info into custom_fields
      const cf = {};
      if (row.moveIn)  cf.move_in_date  = row.moveIn;
      if (row.leaseTo) cf.lease_end_date = row.leaseTo;
      if (row.rent)    cf.base_rent     = String(row.rent).replace(/,/g,'');
      if (Object.keys(cf).length) {
        sets.push(`custom_fields=custom_fields||$${idx++}::jsonb`);
        params.push(JSON.stringify(cf));
      }
      sets.push(`updated_at=NOW()`);
      params.push(match.id);

      if (sets.length > 1) { // at least one real field
        await pool.query(`UPDATE people SET ${sets.join(',')} WHERE id=$${idx}`, params);
        updated++;
      }
    }

    res.json({ ok:true, updated, notFound, notFoundList: notFoundList.slice(0,20) });
  } catch(e) {
    console.error('[tenant-dir import]', e.message);
    res.status(500).json({ error: e.message });
  }
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
    const vmR = await pool.query(`
      SELECT
        c.id, c.from_number AS phone, c.created_at, c.recording_url,
        c.duration_seconds, c.transcript, c.summary,
        c.status, c.direction,
        p.id AS person_id,
        COALESCE(p.first_name || ' ' || COALESCE(p.last_name,''), c.from_number) AS contact_name
      FROM calls c
      LEFT JOIN people p ON p.id::text = c.person_id
      WHERE c.status = 'voicemail'
        AND c.created_at > NOW() - INTERVAL '30 days'
        AND (c.inbox_cleared IS NULL OR c.inbox_cleared = false)
      ORDER BY c.created_at DESC
      LIMIT 50
    `);
    res.json({ missed_calls: missedR.rows, unread_texts: textsR.rows, voicemails: vmR.rows });
  } catch(e) { console.error('Inbox error:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/inbox/clear', auth, async (req, res) => {
  try {
    const { type } = req.body;
    if (type === 'missed' || type === 'all') {
      await pool.query(`UPDATE calls SET inbox_cleared=true WHERE direction='inbound' AND status IN ('no-answer','busy','failed','canceled') AND created_at > NOW() - INTERVAL '7 days'`);
    }
    if (type === 'voicemails' || type === 'all') {
      await pool.query(`UPDATE calls SET inbox_cleared=true WHERE status='voicemail' AND created_at > NOW() - INTERVAL '30 days'`);
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

// Bulk count endpoint — returns { listId: count } for all smart lists
app.get('/api/smart-lists/counts', auth, async (req, res) => {
  try {
    const listsR = await pool.query('SELECT * FROM smart_lists ORDER BY sort_order');
    const counts = {};
    await Promise.all(listsR.rows.map(async list => {
      try {
        const f = list.filters || {};
        if (f.type === 'upcoming_showings_72h') {
          const r = await pool.query(`
            SELECT COUNT(DISTINCT p.id)::int AS cnt
            FROM people p
            JOIN showings s ON s.connect_person_id = p.id::text
              AND s.showing_time BETWEEN NOW() - INTERVAL '2 hours' AND NOW() + INTERVAL '14 days'
              AND LOWER(s.status) = 'scheduled'
          `);
          counts[list.id] = r.rows[0]?.cnt || 0;
        } else if (f.type === 'toured_no_followup') {
          const days = parseInt(f.days_ago || 7);
          const r = await pool.query(`
            SELECT COUNT(DISTINCT p.id)::int AS cnt
            FROM people p
            JOIN showings s ON s.connect_person_id = p.id::text
              AND s.showing_time < NOW()
              AND s.showing_time > NOW() - INTERVAL '1 day' * $1
              AND s.status = 'Completed'
            JOIN LATERAL (
              SELECT showing_time AS last_tour FROM showings
              WHERE connect_person_id = p.id::text AND status = 'Completed' AND showing_time < NOW()
              ORDER BY showing_time DESC LIMIT 1
            ) s2 ON TRUE
            LEFT JOIN activities a ON a.person_id::text = p.id::text
            GROUP BY p.id, s2.last_tour
            HAVING MAX(a.created_at) FILTER (
              WHERE a.direction='outbound' AND a.created_at > s2.last_tour
            ) IS NULL
          `, [days]);
          counts[list.id] = r.rows[0]?.cnt ?? r.rows.length;
        } else {
          let where = ['1=1']; let params = [];
          if (f.stages?.length > 1) { params.push(f.stages); where.push(`stage=ANY($${params.length})`); }
          else if (f.stage) { params.push(f.stage); where.push(`stage=$${params.length}`); }
          if (f.tags?.length) { for (const t of f.tags) { params.push(t); where.push(`$${params.length}=ANY(tags)`); } }
          const r = await pool.query(
            `SELECT COUNT(*)::int AS cnt FROM people WHERE ${where.join(' AND ')}`, params
          );
          counts[list.id] = r.rows[0]?.cnt || 0;
        }
      } catch(e) { counts[list.id] = null; }
    }));
    res.json(counts);
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// xAI Responses API with web_search tool (replaces deprecated search_parameters)
async function fetchGrokWithSearch(prompt, maxTokens = 600) {
  if (!process.env.GROK_API_KEY) throw new Error('Grok API key not configured');
  const resp = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROK_API_KEY}`
    },
    body: JSON.stringify({
      model: 'grok-4-1-fast',
      input: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search' }],
      max_output_tokens: maxTokens,
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Grok search ${resp.status}: ${errText.substring(0, 200)}`);
  }
  const data = await resp.json();
  // Extract text from output_text or output blocks
  if (data.output_text) return data.output_text;
  if (Array.isArray(data.output)) {
    return data.output
      .filter(b => b.type === 'message' && b.content)
      .flatMap(b => b.content)
      .filter(c => c.type === 'output_text' || c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
  return '';
}

// ─── TWILIO TOKEN ─────────────────────────────────────────────────────────────
const buildTwilioToken = async (req, res) => {
  try {
    const missing = [];
    if (!process.env.TWILIO_ACCOUNT_SID)    missing.push('TWILIO_ACCOUNT_SID');
    if (!process.env.TWILIO_API_KEY_SID)    missing.push('TWILIO_API_KEY_SID');
    if (!process.env.TWILIO_API_KEY_SECRET) missing.push('TWILIO_API_KEY_SECRET');
    if (!process.env.TWILIO_TWIML_APP_SID)  missing.push('TWILIO_TWIML_APP_SID');
    if (missing.length) {
      console.error('[Twilio Token] Missing env vars:', missing.join(', '));
      return res.status(503).json({ error: `Twilio not fully configured — missing: ${missing.join(', ')}` });
    }
    const { AccessToken } = require('twilio').jwt;
    const { VoiceGrant } = AccessToken;
    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY_SID,
      process.env.TWILIO_API_KEY_SECRET,
      { identity: String(req.agent.id), ttl: 3600 }
    );
    token.addGrant(new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
      incomingAllow: true
    }));
    const jwt = token.toJwt();
    console.log(`[Twilio Token] Issued to agent ${req.agent.id} (${req.agent.name})`);
    res.json({ token: jwt, identity: String(req.agent.id) });
  } catch (e) {
    console.error('[Twilio Token] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
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

    // ── SCRIPTURE GUARDRAIL: check message content ──
    const smsGuardrail = checkScriptureGuardrails(body);
    if (smsGuardrail.blocked) {
      return res.status(400).json({ error: smsGuardrail.message, guardrail: smsGuardrail.guardrailName });
    }

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
    const { To, CallerId, personId, lineId, agentId, confName, confMuted } = req.body;
    const callSid = req.body.CallSid;
    if (!To) { response.say('No destination number provided.'); return res.type('xml').send(response.toString()); }

    // Agent monitoring a Jareih conference — join as listener or speaker
    if (confName) {
      const dial = response.dial();
      dial.conference(confName, {
        beep: false,
        startConferenceOnEnter: false,
        endConferenceOnExit: false,
        muted: confMuted === 'true'
      });
      return res.type('xml').send(response.toString());
    }
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

    // Check if Jireh inbound is enabled
    const jireh_setting = await pool.query(`SELECT value FROM app_settings WHERE key='jireh_inbound_enabled'`);
    const jireh_inbound = jireh_setting.rows[0]?.value === 'true';

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

    if (jireh_inbound) {
      // ── Jireh AUTO-ANSWER mode: ring humans for ~20s (≈4 rings) first.
      // If a human picks up → normal call. If no answer → Jireh takes over.
      const callInsertJ = await pool.query(
        'INSERT INTO calls (twilio_call_sid,person_id,line_id,direction,status,from_number,to_number) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [callSid, person?.id||null, line?.id||null, 'inbound', 'ringing', fromNum, toNum]
      );
      let agentsJ = [];
      if (line) {
        const aJR = await pool.query('SELECT a.* FROM agents a JOIN line_agents la ON la.agent_id::text=a.id::text WHERE la.line_id=$1 AND a.is_active=true', [line.id]);
        agentsJ = aJR.rows;
      }
      if (agentsJ.length === 0) {
        const aJR = await pool.query('SELECT * FROM agents WHERE is_active=true');
        agentsJ = aJR.rows;
      }

      const VoiceResponseJ = require('twilio').twiml.VoiceResponse;
      const respJ = new VoiceResponseJ();

      if (agentsJ.length > 0) {
        // Ring all agents; action fires when dial ends (answered OR timed-out)
        const dialJ = respJ.dial({
          record: 'record-from-ringing-dual',
          recordingStatusCallback: `${process.env.APP_URL}/api/twilio/recording`,
          recordingStatusCallbackMethod: 'POST',
          timeout: 20, // ~4 rings — then Jireh fallback fires
          action: `${process.env.APP_URL}/api/twilio/inbound-jireh-fallback?origCallSid=${encodeURIComponent(callSid)}&fromNum=${encodeURIComponent(fromNum)}&toNum=${encodeURIComponent(toNum)}&personId=${encodeURIComponent(person?.id||'')}&callDbId=${encodeURIComponent(callInsertJ.rows[0].id)}`,
          method: 'POST'
        });
        agentsJ.forEach(a => dialJ.client(a.id));
      } else {
        // No agents online — Jireh answers immediately (redirect to fallback)
        respJ.redirect({method:'POST'}, `${process.env.APP_URL}/api/twilio/inbound-jireh-fallback?origCallSid=${encodeURIComponent(callSid)}&fromNum=${encodeURIComponent(fromNum)}&toNum=${encodeURIComponent(toNum)}&personId=${encodeURIComponent(person?.id||'')}&callDbId=${encodeURIComponent(callInsertJ.rows[0].id)}&noAgents=1`);
      }

      res.type('xml').send(respJ.toString());
      return;
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
      // Check for custom voicemail greeting
      const greetAudioR = await pool.query(`SELECT value FROM app_settings WHERE key='voicemail_greeting_b64'`);
      if (greetAudioR.rows[0]?.value) {
        response.play(`${process.env.APP_URL}/voicemail-greeting.mp3`);
      } else {
        response.say('You have reached OKCREAL. Please leave a message after the beep.');
      }
      response.record({
        maxLength: 120,
        playBeep: true,
        recordingStatusCallback: `${process.env.APP_URL}/api/twilio/voicemail?callId=${callInsert.rows[0].id}`,
        recordingStatusCallbackMethod: 'POST',
        transcribe: false
      });
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
  try {
    const { callSid } = req.query;
    const { DialCallDuration, DialCallStatus } = req.body;
    const duration = parseInt(DialCallDuration) || 0;
    const status = DialCallStatus || 'completed';

    // If a human answered, just update the DB
    if (DialCallStatus === 'answered') {
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
      res.type('xml').send('<Response></Response>');
      return;
    }

    // No human answered → send to voicemail
    const callR = await pool.query('SELECT id FROM calls WHERE twilio_call_sid=$1', [callSid]);
    const callDbId = callR.rows[0]?.id;
    await pool.query('UPDATE calls SET status=$1,ended_at=NOW() WHERE twilio_call_sid=$2', ['no-answer', callSid]).catch(()=>{});

    const VoiceResponse = require('twilio').twiml.VoiceResponse;
    const vmResp = new VoiceResponse();
    const greetAudioR = await pool.query(`SELECT value FROM app_settings WHERE key='voicemail_greeting_b64'`);
    if (greetAudioR.rows[0]?.value) {
      vmResp.play(`${process.env.APP_URL}/voicemail-greeting.mp3`);
    } else {
      vmResp.say('You have reached OKCREAL. No one is available right now. Please leave a message after the beep.');
    }
    vmResp.record({
      maxLength: 120,
      playBeep: true,
      recordingStatusCallback: `${process.env.APP_URL}/api/twilio/voicemail?callId=${callDbId || ''}`,
      recordingStatusCallbackMethod: 'POST',
      transcribe: false
    });
    res.type('xml').send(vmResp.toString());
  } catch (e) { console.error('inbound-complete error:', e.message); res.type('xml').send('<Response></Response>'); }
});

// ─── Jireh Fallback: fires after agents don't answer within ~4 rings ──────────
// Twilio calls this as the <Dial action> when the dial ends.
// DialCallStatus === 'answered' means a human picked up → nothing to do.
// Any other status (no-answer, busy, failed, canceled) → hand call to Jireh.
app.post('/api/twilio/inbound-jireh-fallback', async (req, res) => {
  try {
    const { DialCallStatus } = req.body;
    const { origCallSid, fromNum, toNum, personId, callDbId, noAgents } = req.query;
    const callSid = req.body.CallSid || origCallSid;

    // Human answered — update DB record and we're done
    if (DialCallStatus === 'answered' && !noAgents) {
      if (callDbId) {
        pool.query('UPDATE calls SET status=$1 WHERE id=$2', ['answered', callDbId]).catch(()=>{});
      }
      res.type('xml').send('<Response></Response>');
      return;
    }

    // No human answered (or no agents at all) — spin up Jireh
    const greetingR = await pool.query(`SELECT value FROM app_settings WHERE key='jireh_inbound_greeting'`);
    const greeting = greetingR.rows[0]?.value || 'Hi, thanks for calling O.K.C. Real!';

    let person = null;
    if (personId) {
      const pR = await pool.query('SELECT * FROM people WHERE id=$1', [personId]).catch(()=>({rows:[]}));
      person = pR.rows[0] || null;
    }

    const actsR = await pool.query(
      `SELECT type,body,direction,created_at FROM activities WHERE person_id=$1 ORDER BY created_at DESC LIMIT 15`,
      [String(personId || '')]
    ).catch(()=>({rows:[]}));

    const callId = `jc-inbound-${Date.now()}-${require('crypto').randomBytes(4).toString('hex')}`;
    const wsBase = process.env.APP_URL?.replace(/^http/, 'ws') || 'wss://localhost:3000';

    // Upsert the calls record to mark it as Jireh-handled
    let callDbIdFinal = callDbId;
    if (!callDbIdFinal) {
      const insertR = await pool.query(
        `INSERT INTO calls (twilio_call_sid, person_id, direction, status, from_number, to_number, started_at, call_source)
         VALUES ($1, $2, 'inbound', 'ringing', $3, $4, NOW(), 'jireh') RETURNING id`,
        [callSid, person?.id||null, fromNum, toNum]
      );
      callDbIdFinal = insertR.rows[0].id;
    } else {
      pool.query(`UPDATE calls SET call_source='jireh', status='ringing' WHERE id=$1`, [callDbId]).catch(()=>{});
    }

    jareihCalls.set(callId, {
      personId: String(person?.id||''),
      agentId: null,
      goal: 'Answer the inbound caller, identify their need, and assist them or take a message.',
      context: {
        name: person ? `${person.first_name} ${person.last_name||''}`.trim() : 'Unknown caller',
        phone: fromNum, stage: person?.stage||'Unknown',
        notes: person?.notes||'', email: person?.email||'',
        recentActivity: actsR.rows
      },
      transcript: [],
      contactCallSid: callSid,
      aiBridgeCallSid: null,
      callDbId: callDbIdFinal,
      araMuted: false, araActive: true,
      greetingFired: false, greetingOverride: greeting,
      shouldEnd: false, goalAchieved: false, finalized: false,
      startedAt: Date.now(), callStatus: 'ringing',
      streamSid: null, ws: null, araLock: 0,
      grokHistory: [], listeners: [],
      direction: 'inbound'
    });

    broadcastToAll({ type: 'jareih_active_calls', calls: getActiveCallsPayload() });

    res.type('xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsBase}/ws/jareih-call/${callId}">
      <Parameter name="callId" value="${callId}"/>
    </Stream>
  </Connect>
</Response>`);
  } catch(e) {
    console.error('[Jireh fallback] error:', e.message);
    res.type('xml').send('<Response><Say>Thank you for calling OKCREAL. Please try again shortly.</Say></Response>');
  }
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

    // For Jareih AI calls, we already have a real-time transcript and summary — just save the recording URL
    if (call.transcript) {
      await pool.query('UPDATE activities SET recording_url=$1 WHERE call_id=$2', [recUrl, call.id]).catch(()=>{});
      console.log('Recording webhook: Jareih call — saved recording_url, skipping re-transcription');
      return;
    }

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
    const { RecordingUrl, RecordingDuration } = req.body;
    if (!callId) return;
    const recUrl = `${RecordingUrl}.mp3`;
    const duration = parseInt(RecordingDuration) || 0;

    await pool.query('UPDATE calls SET status=$1,recording_url=$2,duration_seconds=$3 WHERE id=$4', ['voicemail', recUrl, duration, callId]);
    const callR = await pool.query('SELECT * FROM calls WHERE id=$1', [callId]);
    const call = callR.rows[0];
    if (!call) return;

    // Identify caller
    let callerName = call.from_number || 'Unknown';
    if (call.person_id) {
      const pR = await pool.query('SELECT first_name, last_name FROM people WHERE id=$1', [call.person_id]);
      if (pR.rows[0]) callerName = `${pR.rows[0].first_name} ${pR.rows[0].last_name||''}`.trim();
    }

    // Transcribe via Deepgram if available
    let transcript = '';
    let summary = `Voicemail from ${callerName} (${duration}s)`;
    const dg = initDeepgram();
    if (dg) {
      try {
        const auth = twilioBasicAuth();
        if (auth) {
          const https = require('https');
          const url = new URL(recUrl);
          const audioBuffer = await new Promise((resolve, reject) => {
            const r = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: 'GET', headers: { Authorization: 'Basic ' + auth } }, (res) => {
              if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Twilio fetch ${res.statusCode}`)); }
              const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
            }); r.on('error', reject); r.end();
          });
          const { result } = await dg.listen.prerecorded.transcribeFile(audioBuffer, { model: 'nova-2', smart_format: true, punctuate: true, utterances: true, mimetype: 'audio/mpeg' });
          const utts = result?.results?.utterances;
          if (utts?.length) {
            transcript = utts.map(u => u.transcript).join(' ');
            summary = `Voicemail from ${callerName}: "${transcript.slice(0, 200)}${transcript.length > 200 ? '…' : ''}"`;
          }
        }
      } catch(e) { console.warn('[Voicemail transcribe]', e.message); }
    }

    // Update calls with transcript
    if (transcript) {
      await pool.query('UPDATE calls SET transcript=$1, summary=$2 WHERE id=$3', [transcript, summary, call.id]).catch(()=>{});
    }

    // Insert activity
    await pool.query(
      'INSERT INTO activities (person_id,call_id,type,body,recording_url,direction,duration) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [call.person_id, call.id, 'voicemail', summary, recUrl, 'inbound', duration]
    ).catch(() => {});

    // Broadcast to all agents
    broadcastToAll({
      type: 'new_voicemail',
      callId: call.id,
      personId: call.person_id,
      callerName,
      phone: call.from_number,
      duration,
      transcript: transcript || null,
      summary,
      createdAt: new Date().toISOString()
    });

    // Create notification for all active agents
    const agentsR = await pool.query('SELECT id FROM agents WHERE is_active=true');
    for (const ag of agentsR.rows) {
      await createNotification({
        recipientId: ag.id,
        type: 'voicemail',
        personId: call.person_id || null,
        body: `📩 Voicemail from ${callerName} (${duration}s)${transcript ? ': "' + transcript.slice(0, 80) + '…"' : ''}`
      }).catch(()=>{});
    }

    console.log(`[Voicemail] ${callerName} left ${duration}s voicemail${transcript ? ' (transcribed)' : ''}`);
  } catch (e) { console.error('Voicemail error:', e.message); }
});

// ─── DATA ENRICHMENT (People Data Labs) ──────────────────────────────────────
app.get('/api/people/:id/enrich', auth, async (req, res) => {
  try {
    const personId = req.params.id;
    const forceRefresh = req.query.refresh === '1';

    // Fetch full person record including OCR data and CRM context
    const pR = await pool.query(`SELECT p.*, 
      (SELECT COUNT(*) FROM activities WHERE person_id=p.id::text AND type='call') as call_count,
      (SELECT COUNT(*) FROM activities WHERE person_id=p.id::text AND type='sms') as sms_count,
      (SELECT created_at FROM activities WHERE person_id=p.id::text ORDER BY created_at DESC LIMIT 1) as last_activity,
      (SELECT body FROM activities WHERE person_id=p.id::text AND type='call' AND body IS NOT NULL ORDER BY created_at DESC LIMIT 1) as last_call_summary
    FROM people p WHERE p.id=$1`, [personId]);
    const person = pR.rows[0];
    if (!person) return res.status(404).json({ error: 'Contact not found' });

    const idOcr = person.custom_fields?.id_ocr || null;

    // Return cached enrichment if less than 30 days old (unless forced)
    const cached = person.custom_fields?.pdl_enrichment;
    if (!forceRefresh && cached && cached.fetched_at && cached.status !== 'no_match') {
      const age = Date.now() - new Date(cached.fetched_at).getTime();
      if (age < 30 * 86400000) return res.json({ enrichment: cached, idOcr, cached: true });
    }

    // ── PDL Enrichment ──
    const pdlKey = process.env.PDL_API_KEY;
    let enrichment = { status: 'no_match', fetched_at: new Date().toISOString() };

    if (pdlKey) {
      const params = new URLSearchParams();
      params.set('api_key', pdlKey);
      params.set('min_likelihood', '2'); // Low threshold for renters
      params.set('data_include', 'full_name,sex,birth_year,birth_date,linkedin_url,facebook_url,twitter_url,industry,job_title,job_company_name,job_company_industry,location_name,experience,education,skills,interests,summary,emails,phones');

      // Use OCR data if available (much better match signals)
      const firstName = idOcr?.first_name || person.first_name;
      const lastName = idOcr?.last_name || person.last_name;
      if (firstName) params.set('first_name', firstName);
      if (lastName) params.set('last_name', lastName);
      if (person.email) params.set('email', person.email);

      // Phone — normalize
      const phone = person.phone?.replace(/\D/g, '');
      if (phone && phone.length >= 10) params.set('phone', '+1' + phone.slice(-10));

      // DOB from OCR — strongest match signal for renters
      if (idOcr?.date_of_birth) params.set('birth_date', idOcr.date_of_birth);

      // Address — from OCR first, then CRM
      const addr = idOcr?.address || person.address;
      const city = idOcr?.city || person.city;
      const state = idOcr?.state || person.state;
      if (addr) params.set('street_address', addr);
      if (city && state) params.set('location', `${city}, ${state}`);
      else if (city || state) params.set('location', city || state);
      else params.set('location', 'Oklahoma City, Oklahoma');

      console.log(`[PDL Enrich] Looking up ${firstName} ${lastName} (DOB: ${idOcr?.date_of_birth || 'none'}, email: ${person.email || 'none'}, phone: ${person.phone || 'none'})`);

      try {
        const pdlResp = await fetch(`https://api.peopledatalabs.com/v5/person/enrich?${params}`, {
          headers: { 'X-Api-Key': pdlKey }
        });
        const pdlData = await pdlResp.json();

        if (pdlData.status === 200 && pdlData.data) {
          const d = pdlData.data;
          enrichment = {
            status: 'matched',
            likelihood: pdlData.likelihood || 0,
            fetched_at: new Date().toISOString(),
            full_name: d.full_name,
            sex: d.sex,
            birth_year: d.birth_year,
            birth_date: d.birth_date,
            age: d.birth_year ? (new Date().getFullYear() - d.birth_year) : null,
            linkedin_url: d.linkedin_url ? `https://${d.linkedin_url}` : null,
            facebook_url: d.facebook_url ? `https://${d.facebook_url}` : null,
            twitter_url: d.twitter_url ? `https://${d.twitter_url}` : null,
            industry: d.industry,
            job_title: d.job_title,
            job_company_name: d.job_company_name,
            job_company_industry: d.job_company_industry,
            location_name: d.location_name,
            summary: d.summary,
            skills: (d.skills || []).slice(0, 10),
            interests: (d.interests || []).slice(0, 8),
            experience: (d.experience || []).slice(0, 5).map(e => ({
              title: e.title?.name || e.title,
              company: e.company?.name,
              industry: e.company?.industry,
              start: e.start_date,
              end: e.end_date,
              current: !e.end_date
            })),
            education: (d.education || []).slice(0, 3).map(e => ({
              school: e.school?.name,
              degree: e.degrees?.join(', '),
              major: e.majors?.join(', '),
              end: e.end_date
            })),
            additional_emails: (d.emails || []).filter(e => e.address !== person.email).map(e => e.address).slice(0, 3),
            additional_phones: (d.phones || []).filter(p => p.number !== person.phone).map(p => p.number).slice(0, 3)
          };
          console.log(`[PDL Enrich] Matched → ${d.job_title || 'no title'} at ${d.job_company_name || '?'} (likelihood: ${pdlData.likelihood})`);
        } else {
          console.log(`[PDL Enrich] No match (status: ${pdlData.status})`);
        }
      } catch(pdlErr) { console.warn('[PDL Enrich] API error:', pdlErr.message); }
    }

    // Cache PDL result
    await pool.query(
      `UPDATE people SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || $1::jsonb WHERE id=$2`,
      [JSON.stringify({ pdl_enrichment: enrichment }), personId]
    ).catch(() => {});

    // ── AI Intelligence Brief ──
    let aiBrief = null;
    const grok = initGrok();
    if (grok) {
      try {
        const stage = person.stage || 'Lead';
        const daysSinceCreated = Math.round((Date.now() - new Date(person.created_at).getTime()) / 86400000);
        const daysSinceActivity = person.last_activity ? Math.round((Date.now() - new Date(person.last_activity).getTime()) / 86400000) : null;
        const pastDue = person.custom_fields?.past_due_balance || person.past_due_balance;
        const pastDueDays = person.custom_fields?.past_due_days || person.past_due_days;

        const briefPrompt = `You are an intelligence analyst for OKCREAL, a property management company in Oklahoma City. Generate a concise AGENT INTELLIGENCE BRIEF for a leasing/enforcement agent about this person. Be direct, factual, and actionable.

PERSON IN CRM:
- Name: ${person.first_name} ${person.last_name || ''}
- Stage: ${stage}
- In CRM since: ${daysSinceCreated} days
- Last activity: ${daysSinceActivity !== null ? daysSinceActivity + ' days ago' : 'never'}
- Total calls: ${person.call_count || 0}, texts: ${person.sms_count || 0}
- Source: ${person.source || 'unknown'}
- Tags: ${person.tags || 'none'}
- Notes: ${(person.notes || '').slice(0, 300)}
${pastDue ? `- PAST DUE BALANCE: $${pastDue}` : ''}
${pastDueDays ? `- DAYS OVERDUE: ${pastDueDays}` : ''}
${person.last_call_summary ? `- Last call summary: ${person.last_call_summary.slice(0, 200)}` : ''}

${idOcr ? `ID DOCUMENT (OCR):
- Legal name: ${idOcr.full_legal_name || '?'}
- DOB: ${idOcr.date_of_birth || '?'} (Age: ${idOcr.age || '?'})
- Address on ID: ${[idOcr.address, idOcr.city, idOcr.state, idOcr.zip].filter(Boolean).join(', ') || '?'}
- ID #: ${idOcr.id_number || '?'} (${idOcr.issuing_state || '?'} ${idOcr.id_type || 'ID'})
- Expires: ${idOcr.expiration_date || '?'}${idOcr.is_expired ? ' ⚠️ EXPIRED' : ''}
` : 'NO ID ON FILE'}

${enrichment.status === 'matched' ? `BACKGROUND DATA (People Data Labs, confidence ${enrichment.likelihood}/10):
- Current job: ${enrichment.job_title || 'unknown'} at ${enrichment.job_company_name || 'unknown'}
- Industry: ${enrichment.industry || '?'}
- Location: ${enrichment.location_name || '?'}
- Employment history: ${(enrichment.experience || []).map(e => `${e.title || '?'} at ${e.company || '?'} (${e.start || '?'}–${e.end || 'present'})`).join('; ') || 'none found'}
- Education: ${(enrichment.education || []).map(e => e.school).filter(Boolean).join(', ') || 'none found'}
- Social: ${[enrichment.linkedin_url ? 'LinkedIn' : null, enrichment.facebook_url ? 'Facebook' : null].filter(Boolean).join(', ') || 'none'}
` : 'NO BACKGROUND MATCH FOUND — this person has a thin public footprint.'}

Write 3-5 sentences. Focus on:
1. Employment stability — are they currently employed? Recent gaps? Frequent job changes?
2. Risk assessment — given their stage (${stage}), how should the agent approach them?
3. Specific recommended action — what should the agent do RIGHT NOW?
${stage === 'Delinquent' || stage === 'Evicting' ? '4. Payment ability — based on employment data, can they likely pay? Should we offer a payment plan or connect with rent assistance?' : ''}
Be specific and practical. This is for a property manager, not a credit agency.`;

        const briefResp = await grok.chat.completions.create({
          model: 'grok-3', max_tokens: 400,
          messages: [{ role: 'user', content: briefPrompt }]
        });
        aiBrief = briefResp.choices[0]?.message?.content?.trim() || null;
      } catch(e) { console.warn('[AI Brief] Error:', e.message); }
    }

    res.json({ enrichment, idOcr, aiBrief, cached: false });
  } catch(e) {
    console.error('[Enrich] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── VOICEMAIL GREETING ──────────────────────────────────────────────────────
// Upload: saves audio as base64 in app_settings so Twilio can play it
const uploadGreeting = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  const ok = ['audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/ogg','audio/webm','audio/mp4','audio/x-m4a'].includes(file.mimetype);
  cb(null, ok);
}});

app.post('/api/admin/voicemail-greeting', auth, adminOnly, uploadGreeting.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });
    const b64 = req.file.buffer.toString('base64');
    const mime = req.file.mimetype || 'audio/mpeg';
    await pool.query(
      `INSERT INTO app_settings(key,value) VALUES('voicemail_greeting_b64',$1) ON CONFLICT(key) DO UPDATE SET value=$1`,
      [b64]
    );
    await pool.query(
      `INSERT INTO app_settings(key,value) VALUES('voicemail_greeting_mime',$1) ON CONFLICT(key) DO UPDATE SET value=$1`,
      [mime]
    );
    console.log(`[Voicemail] Greeting uploaded: ${req.file.originalname} (${Math.round(b64.length/1024)}KB, ${mime})`);
    res.json({ ok: true, size: req.file.size, mime });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/voicemail-greeting', auth, adminOnly, async (req, res) => {
  try {
    await pool.query(`DELETE FROM app_settings WHERE key IN ('voicemail_greeting_b64','voicemail_greeting_mime')`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/voicemail-greeting/status', auth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT key,value FROM app_settings WHERE key='voicemail_greeting_mime'`);
    res.json({ hasGreeting: r.rows.length > 0, mime: r.rows[0]?.value || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Public endpoint — Twilio fetches this (no auth) to play the greeting
app.get('/voicemail-greeting.mp3', async (req, res) => {
  try {
    const [b64R, mimeR] = await Promise.all([
      pool.query(`SELECT value FROM app_settings WHERE key='voicemail_greeting_b64'`),
      pool.query(`SELECT value FROM app_settings WHERE key='voicemail_greeting_mime'`)
    ]);
    if (!b64R.rows[0]?.value) return res.status(404).send('No greeting');
    const buf = Buffer.from(b64R.rows[0].value, 'base64');
    res.set('Content-Type', mimeR.rows[0]?.value || 'audio/mpeg');
    res.set('Content-Length', buf.length);
    res.set('Cache-Control', 'public, max-age=300');
    res.send(buf);
  } catch(e) { res.status(500).send('Error'); }
});

// Preview endpoint (authenticated, for admin to listen in-app)
app.get('/api/admin/voicemail-greeting/preview', auth, async (req, res) => {
  try {
    const [b64R, mimeR] = await Promise.all([
      pool.query(`SELECT value FROM app_settings WHERE key='voicemail_greeting_b64'`),
      pool.query(`SELECT value FROM app_settings WHERE key='voicemail_greeting_mime'`)
    ]);
    if (!b64R.rows[0]?.value) return res.status(404).json({ error: 'No greeting uploaded' });
    const buf = Buffer.from(b64R.rows[0].value, 'base64');
    res.set('Content-Type', mimeR.rows[0]?.value || 'audio/mpeg');
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
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
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS ssn TEXT`, 'people.ssn');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS is_military BOOLEAN DEFAULT FALSE`, 'people.is_military');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS appfolio_unit TEXT`, 'people.appfolio_unit');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS appfolio_property TEXT`, 'people.appfolio_property');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT FALSE`, 'people.is_blocked');
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS notes TEXT`, 'people.notes');
  await run(`ALTER TABLE people ALTER COLUMN first_name TYPE TEXT`, 'people.first_name->TEXT');
  await run(`ALTER TABLE people ALTER COLUMN last_name TYPE TEXT`, 'people.last_name->TEXT');
  await run(`ALTER TABLE people ALTER COLUMN phone TYPE TEXT`, 'people.phone->TEXT');
  await run(`ALTER TABLE people ALTER COLUMN email TYPE TEXT`, 'people.email->TEXT');
  await run(`ALTER TABLE people ALTER COLUMN stage TYPE TEXT`, 'people.stage->TEXT');
  await run(`ALTER TABLE people ALTER COLUMN source TYPE TEXT`, 'people.source->TEXT');
  await run(`ALTER TABLE people ALTER COLUMN background TYPE TEXT`, 'people.background->TEXT');
  // Drop stale FK on assigned_to before altering type (was referencing agents, now plain TEXT)
  await pool.query(`ALTER TABLE people DROP CONSTRAINT IF EXISTS people_assigned_to_fkey`).catch(()=>{});
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
  await pool.query(`INSERT INTO app_settings(key,value) VALUES('jireh_inbound_enabled','false') ON CONFLICT(key) DO NOTHING`).catch(()=>{});
  await pool.query(`INSERT INTO app_settings(key,value) VALUES('jireh_inbound_greeting','Hi, thanks for calling O.K.C. Real! This is Jireh, an AI assistant. How can I help you today?') ON CONFLICT(key) DO NOTHING`).catch(()=>{});
  await pool.query(`ALTER TABLE calls ADD COLUMN IF NOT EXISTS call_source TEXT DEFAULT 'human'`).catch(()=>{});;
  await pool.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS mentions TEXT[] DEFAULT '{}'`).catch(()=>{});
  await pool.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS email_subject TEXT`).catch(()=>{});
  await pool.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS gmail_message_id TEXT`).catch(()=>{});
  // Create unique constraint for gmail dedup — critical for ON CONFLICT to work
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS activities_gmail_msg_idx ON activities(gmail_message_id) WHERE gmail_message_id IS NOT NULL`)
    .catch(e => console.error('[DB] activities_gmail_msg_idx:', e.message));
  // Also add as a formal constraint so ON CONFLICT (gmail_message_id) resolves correctly
  await pool.query(`ALTER TABLE activities ADD CONSTRAINT activities_gmail_message_id_uniq UNIQUE USING INDEX activities_gmail_msg_idx`)
    .catch(() => {}); // no-op if constraint already exists or index name differs
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
  await run(`CREATE TABLE IF NOT EXISTS geocode_cache (
    address TEXT PRIMARY KEY,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`, 'create geocode_cache');
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

  // ── Work Order Alert System — adds alert columns, indexes, person linkage ──
  await initWorkOrderAlerts(pool);

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

  // Seed smart lists — only if not already present AND not previously deleted
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
      { name: '👻 Tours — No Follow-Up', filters: { type: 'toured_no_followup', days_ago: 7 }, sort_order: 2 },
    ];
    // Only seed lists that aren't tombstoned
    const deletedR = await pool.query('SELECT name FROM deleted_smart_lists');
    const deletedNames = new Set(deletedR.rows.map(r => r.name));
    for (const sl of smartListDefs) {
      if (deletedNames.has(sl.name)) continue; // user deleted this — never re-seed
      await pool.query(
        `INSERT INTO smart_lists (name,filters,sort_order) VALUES($1,$2::jsonb,$3) ON CONFLICT (name) DO NOTHING`,
        [sl.name, JSON.stringify(sl.filters), sl.sort_order]
      ).catch(() => {});
    }
  } catch (e) { console.error('[DB] seed smart_lists:', e.message); }

  // Migrate toured_no_followup to 7-day window (was 90)
  await pool.query(
    `UPDATE smart_lists SET filters = filters || '{"days_ago":7}'::jsonb WHERE name = '👻 Tours — No Follow-Up' AND (filters->>'days_ago')::int != 7`
  ).catch(() => {});

  // Seed custom fields — add key column if live DB is on older schema
  await pool.query(`ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS key TEXT`).catch(()=>{});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS custom_fields_key_idx ON custom_fields(key) WHERE key IS NOT NULL`).catch(()=>{});
  try {
    await pool.query(`INSERT INTO custom_fields (key,label,field_type,sort_order) VALUES ('past_due_balance','Past Due Balance','number',0), ('past_due_days','Days Past Due','number',1), ('payment_commitment_date','Payment Commitment Date','date',2), ('unit_number','Unit Number','text',3), ('lease_end_date','Lease End Date','date',4) ON CONFLICT (key) DO NOTHING`);
  } catch (e) { /* silent — custom_fields seeded or schema mismatch, non-fatal */ }

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

// ─── Agent Call State (on-call / off-call broadcast) ─────────────────────────
const _agentsOnCall = new Map(); // agentId -> { name, personId, direction, since }

app.post('/api/me/call-state', auth, (req, res) => {
  const { state, personId, personName, direction } = req.body; // state: 'on-call' | 'off-call'
  const agentId = String(req.agent.id);
  if (state === 'on-call') {
    _agentsOnCall.set(agentId, { name: req.agent.name, personId, personName, direction, since: Date.now() });
  } else {
    _agentsOnCall.delete(agentId);
  }
  broadcastToAll({
    type: 'agent_call_state',
    agentId,
    agentName: req.agent.name,
    state,
    personId: personId || null,
    personName: personName || null,
    direction: direction || null,
    onCallAgentIds: Array.from(_agentsOnCall.keys())
  });
  res.json({ ok: true });
});

app.get('/api/agents/on-call', auth, (req, res) => {
  const result = {};
  for (const [id, info] of _agentsOnCall) { result[id] = info; }
  res.json(result);
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

// ─── GMAIL HISTORY SYNC ───────────────────────────────────────────────────────

// Helper: decode Gmail message body (handles multipart)
function extractGmailBody(payload) {
  if (!payload) return '';
  const decode = (data) => {
    if (!data) return '';
    try { return Buffer.from(data.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf-8'); }
    catch(e) { return ''; }
  };
  // Multipart — recurse into parts
  if (payload.parts && payload.parts.length) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain') return decode(part.body?.data);
    }
    // fallback: first part
    return extractGmailBody(payload.parts[0]);
  }
  return decode(payload.body?.data);
}

// Sync all emails to/from a contact's email address for all connected agents
async function syncGmailForContact(personId, contactEmail, agentRows) {
  if (!contactEmail) return 0;
  let imported = 0;

  for (const agent of agentRows) {
    if (!agent.gmail_refresh_token) continue;
    try {
      const oauth2 = getGmailOAuth(agent);
      const gmail = google.gmail({ version: 'v1', auth: oauth2 });

      // Search sent + received from this contact
      const queries = [
        `to:${contactEmail}`,
        `from:${contactEmail}`
      ];

      for (const q of queries) {
        const listRes = await gmail.users.messages.list({
          userId: 'me',
          q,
          maxResults: 100
        });
        const messages = listRes.data.messages || [];

        for (const { id: msgId } of messages) {
          // Skip if already imported
          const exists = await pool.query(
            'SELECT 1 FROM activities WHERE gmail_message_id=$1 LIMIT 1', [msgId]
          );
          if (exists.rows.length) continue;

          try {
            const msg = await gmail.users.messages.get({
              userId: 'me', id: msgId, format: 'full'
            });
            const headers = msg.data.payload?.headers || [];
            const hdr = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

            const subject = hdr('Subject');
            const from    = hdr('From');
            const to      = hdr('To');
            const dateStr = hdr('Date');
            const sentAt  = dateStr ? new Date(dateStr) : new Date(parseInt(msg.data.internalDate));
            if (isNaN(sentAt.getTime())) continue;

            const body = extractGmailBody(msg.data.payload);
            if (!body && !subject) continue;

            // Determine direction: did we send it or receive it?
            const agentGmail = agent.gmail_email?.toLowerCase() || '';
            const fromEmail  = from.toLowerCase();
            const direction  = fromEmail.includes(agentGmail) ? 'outbound' : 'inbound';

            const fullBody = `From: ${from}\nTo: ${to}\nSubject: ${subject}\n\n${body.trim()}`;

            try {
              await pool.query(
                `INSERT INTO activities
                  (person_id, agent_id, type, body, direction, email_subject, gmail_message_id, created_at)
                 VALUES ($1,$2,'email',$3,$4,$5,$6,$7)
                 ON CONFLICT (gmail_message_id) DO NOTHING`,
                [String(personId), String(agent.id), fullBody, direction, subject, msgId, sentAt]
              );
            } catch(insertErr) {
              // If ON CONFLICT fails (index missing), fall back to check-then-insert
              if (insertErr.message.includes('unique or exclusion constraint')) {
                const exists = await pool.query('SELECT 1 FROM activities WHERE gmail_message_id=$1 LIMIT 1', [msgId]);
                if (!exists.rows.length) {
                  await pool.query(
                    `INSERT INTO activities (person_id, agent_id, type, body, direction, email_subject, gmail_message_id, created_at)
                     VALUES ($1,$2,'email',$3,$4,$5,$6,$7)`,
                    [String(personId), String(agent.id), fullBody, direction, subject, msgId, sentAt]
                  );
                }
              } else throw insertErr;
            }
            imported++;
          } catch(msgErr) {
            console.warn('[Gmail sync] message error:', msgErr.message);
          }
        }
      }
    } catch(agentErr) {
      console.warn('[Gmail sync] agent error:', agentErr.message);
    }
  }
  return imported;
}

// On-demand sync for a single contact
app.post('/api/gmail/sync-contact', auth, async (req, res) => {
  const { personId } = req.body;
  if (!personId) return res.status(400).json({ error: 'personId required' });

  const personR = await pool.query('SELECT email FROM people WHERE id=$1', [personId]);
  const contactEmail = personR.rows[0]?.email;
  if (!contactEmail) return res.json({ imported: 0, note: 'No email on contact' });

  // Sync for all agents who have Gmail connected
  const agentsR = await pool.query(
    'SELECT id, gmail_refresh_token, gmail_email, name FROM agents WHERE gmail_refresh_token IS NOT NULL AND is_active=true'
  );
  const imported = await syncGmailForContact(personId, contactEmail, agentsR.rows);
  res.json({ ok: true, imported });
});

// Background sync — runs on boot and every 15 min
async function backgroundGmailSync() {
  try {
    const agentsR = await pool.query(
      'SELECT id, gmail_refresh_token, gmail_email, name FROM agents WHERE gmail_refresh_token IS NOT NULL AND is_active=true'
    );
    if (!agentsR.rows.length) return;

    // Get all people with emails, most recently updated first, cap at 200
    const peopleR = await pool.query(
      `SELECT id, email FROM people WHERE email IS NOT NULL AND email != '' ORDER BY updated_at DESC LIMIT 200`
    );
    let total = 0;
    for (const person of peopleR.rows) {
      total += await syncGmailForContact(person.id, person.email, agentsR.rows);
    }
    if (total > 0) console.log(`[Gmail sync] Background sync imported ${total} emails`);
  } catch(e) {
    console.warn('[Gmail sync] Background error:', e.message);
  }
}
// Run on boot (after 10s delay to let DB settle) then every 15 min
setTimeout(backgroundGmailSync, 10000);
setInterval(backgroundGmailSync, 15 * 60 * 1000);

// ─── LEAD INBOUND EMAIL WEBHOOK ───────────────────────────────────────────────
// =============================================================================
// GMAIL LEAD SCRAPER — pulls lead emails from connected Gmail accounts
// =============================================================================

// Known lead notification senders from listing platforms
const LEAD_SENDER_PATTERNS = [
  /zillow\.com/i,
  /apartments\.com/i,
  /apartmentlist\.com/i,
  /rent\.com/i,
  /rentpath\.com/i,
  /trulia\.com/i,
  /hotpads\.com/i,
  /zumper\.com/i,
  /cozy\.co/i,
  /doorsteps\.com/i,
  /realtor\.com/i,
  /facebook\.com/i,
  /lead/i,
  /inquiry/i,
  /contact.*request/i,
  /showing.*request/i,
  /rental.*inquiry/i,
  /apartment.*inquiry/i,
  /new.*lead/i,
  /prospective.*tenant/i,
  /appfolio\.com/i,
  /buildium/i,
  /yardi/i,
  /forrent\.com/i,
  /padmapper/i,
  /craigslist/i,
];

function looksLikeLead(from, subject) {
  const text = `${from} ${subject}`.toLowerCase();
  return LEAD_SENDER_PATTERNS.some(p => p.test(text));
}

// AI extraction — same as inbound webhook but reusable
async function extractLeadFromEmail({ from, subject, body }) {
  const grok = initGrok();
  if (!grok) {
    // Pattern-based fallback — extract what we can with regex
    const emailMatch = body.match(/[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/g);
    const phoneMatch = body.match(/(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g);
    const nameMatch = body.match(/(?:name|from|contact)[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)/i);
    return {
      is_lead: true,
      first_name: nameMatch?.[1]?.split(' ')[0] || 'Lead',
      last_name: nameMatch?.[1]?.split(' ')[1] || '',
      email: emailMatch?.find(e => !e.includes('noreply') && !e.includes('zillow') && !e.includes('apartments')) || '',
      phone: phoneMatch?.[0]?.replace(/\D/g,'').slice(-10) || '',
      source: from.includes('zillow') ? 'Zillow' : from.includes('apartments') ? 'Apartments.com' : from.includes('zumper') ? 'Zumper' : from.includes('trulia') ? 'Trulia' : 'Email Lead',
      property: '',
      message: body.substring(0, 500),
    };
  }
  try {
    const r = await grok.chat.completions.create({
      model: 'grok-3', max_tokens: 400,
      messages: [{ role: 'user', content:
        `Extract rental lead contact info from this email notification. Return ONLY JSON, no markdown.
From: ${from}
Subject: ${subject}
Body: ${body.substring(0, 3000)}

JSON format:
{
  "is_lead": true/false,
  "first_name": "",
  "last_name": "",
  "email": "prospect's email (not the platform's)",
  "phone": "10 digits only, no formatting",
  "source": "platform name (Zillow, Apartments.com, etc)",
  "property": "property name or address they inquired about",
  "unit": "unit number if mentioned",
  "message": "their inquiry message verbatim",
  "move_in_date": "if mentioned",
  "bedrooms": "if mentioned"
}
Set is_lead=false for system notifications, billing emails, spam, or emails with no prospect contact info.` }]
    });
    const raw = r.choices[0].message.content.replace(/```json?|```/g,'').trim();
    return JSON.parse(raw);
  } catch(e) {
    console.warn('[LeadScraper] AI extract failed:', e.message);
    return null;
  }
}

// Core scraper — runs for a single agent's Gmail
async function scrapeGmailLeads(agent, opts = {}) {
  const { maxResults = 50, labelFilter = '' } = opts;
  const results = { scanned: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
  if (!agent.gmail_refresh_token) return results;

  try {
    const oauth2 = getGmailOAuth(agent);
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });

    // Search inbox for lead-like emails — last 30 days, unprocessed
    const query = [
      'newer_than:30d',
      '-label:lead-processed',
      '(subject:inquiry OR subject:lead OR subject:contact OR subject:showing OR subject:"rental inquiry" OR subject:"new message" OR from:zillow.com OR from:apartments.com OR from:zumper.com OR from:trulia.com OR from:hotpads.com OR from:rent.com OR from:apartmentlist.com OR from:realtor.com OR from:padmapper.com OR from:appfolio.com)',
    ].join(' ');

    const listRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
    const messages = listRes.data.messages || [];
    results.scanned = messages.length;

    // Create "lead-processed" label if it doesn't exist
    let processedLabelId = null;
    try {
      const labelsRes = await gmail.users.labels.list({ userId: 'me' });
      const existing = labelsRes.data.labels?.find(l => l.name === 'lead-processed');
      if (existing) {
        processedLabelId = existing.id;
      } else {
        const created = await gmail.users.labels.create({ userId: 'me', requestBody: { name: 'lead-processed', labelListVisibility: 'labelHide', messageListVisibility: 'hide' } });
        processedLabelId = created.data.id;
      }
    } catch(e) { /* labels are optional */ }

    for (const { id: msgId } of messages) {
      // Skip already-processed message IDs
      const seen = await pool.query('SELECT 1 FROM lead_scraper_log WHERE gmail_message_id=$1 LIMIT 1', [msgId]);
      if (seen.rows.length) { results.skipped++; continue; }

      try {
        const msg = await gmail.users.messages.get({ userId: 'me', id: msgId, format: 'full' });
        const headers = msg.data.payload?.headers || [];
        const hdr = n => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
        const from = hdr('From');
        const subject = hdr('Subject');
        const body = extractGmailBody(msg.data.payload);

        // Quick filter — skip if it really doesn't look like a lead
        if (!looksLikeLead(from, subject) && !opts.force) {
          await pool.query('INSERT INTO lead_scraper_log (gmail_message_id, agent_id, result, from_addr, subject) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
            [msgId, agent.id, 'skipped_filter', from, subject]);
          results.skipped++;
          // Still label it so we don't re-scan
          if (processedLabelId) gmail.users.messages.modify({ userId:'me', id:msgId, requestBody:{ addLabelIds:[processedLabelId] } }).catch(()=>{});
          continue;
        }

        const fields = await extractLeadFromEmail({ from, subject, body });
        if (!fields || !fields.is_lead) {
          await pool.query('INSERT INTO lead_scraper_log (gmail_message_id, agent_id, result, from_addr, subject) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
            [msgId, agent.id, 'not_lead', from, subject]);
          results.skipped++;
          if (processedLabelId) gmail.users.messages.modify({ userId:'me', id:msgId, requestBody:{ addLabelIds:[processedLabelId] } }).catch(()=>{});
          continue;
        }

        if (!fields.first_name && !fields.email && !fields.phone) {
          results.skipped++;
          if (processedLabelId) gmail.users.messages.modify({ userId:'me', id:msgId, requestBody:{ addLabelIds:[processedLabelId] } }).catch(()=>{});
          continue;
        }

        // Dedup — check email then phone
        let existingPerson = null;
        if (fields.email) {
          const d = await pool.query('SELECT id, first_name, last_name, stage FROM people WHERE LOWER(email)=LOWER($1) LIMIT 1', [fields.email]);
          existingPerson = d.rows[0] || null;
        }
        if (!existingPerson && fields.phone) {
          const digits = fields.phone.replace(/\D/g,'').slice(-10);
          const d = await pool.query(`SELECT id, first_name, last_name, stage FROM people WHERE regexp_replace(COALESCE(phone,''),'\\D','','g') LIKE $1 LIMIT 1`, [`%${digits}`]);
          existingPerson = d.rows[0] || null;
        }

        const phone = fields.phone ? '+1' + fields.phone.replace(/\D/g,'').slice(-10) : null;
        const notes = [
          fields.property && `Interested in: ${fields.property}`,
          fields.unit && `Unit: ${fields.unit}`,
          fields.move_in_date && `Move-in: ${fields.move_in_date}`,
          fields.bedrooms && `Bedrooms: ${fields.bedrooms}`,
          fields.source && `Source: ${fields.source}`,
          fields.message && `Message: ${fields.message}`,
        ].filter(Boolean).join('\n');

        let personId;
        if (existingPerson) {
          // UPDATE — add activity note with new inquiry, maybe update stage
          personId = existingPerson.id;
          const updateFields = [];
          const updateVals = [];
          if (fields.email && !existingPerson.email) { updateFields.push(`email=$${updateVals.length+1}`); updateVals.push(fields.email); }
          if (phone && !existingPerson.phone) { updateFields.push(`phone=$${updateVals.length+1}`); updateVals.push(phone); }
          if (updateFields.length) {
            updateVals.push(personId);
            await pool.query(`UPDATE people SET ${updateFields.join(',')} WHERE id=$${updateVals.length}`, updateVals).catch(()=>{});
          }
          await pool.query(
            `INSERT INTO activities (person_id, agent_id, type, body, direction, created_at) VALUES ($1,$2,'note',$3,'inbound',NOW())`,
            [String(personId), String(agent.id), `🏠 New inquiry via ${fields.source||'Email'}\n\n${notes}`]
          );
          results.updated++;
        } else {
          // CREATE new lead
          const ins = await pool.query(
            `INSERT INTO people (first_name,last_name,email,phone,stage,source,background,updated_at)
             VALUES ($1,$2,$3,$4,'Lead',$5,$6,NOW()) RETURNING id`,
            [fields.first_name||'Lead', fields.last_name||'', fields.email||null, phone, fields.source||'Email Lead', notes||null]
          );
          personId = ins.rows[0].id;
          // Log initial inquiry as activity
          if (notes) {
            await pool.query(
              `INSERT INTO activities (person_id, agent_id, type, body, direction, created_at) VALUES ($1,$2,'note',$3,'inbound',NOW())`,
              [String(personId), String(agent.id), `🏠 Initial inquiry via ${fields.source||'Email'}\n\n${notes}`]
            );
          }
          // Notify all agents
          const agentsR = await pool.query('SELECT id FROM agents WHERE is_active=true');
          for (const ag of agentsR.rows) {
            await createNotification({
              recipientId: ag.id,
              type: 'new_lead',
              personId: String(personId),
              body: `🏠 New lead: ${fields.first_name} ${fields.last_name||''} (${fields.source||'Email'})`
            }).catch(()=>{});
          }
          broadcastToAll({ type: 'new_lead', personId, name: `${fields.first_name} ${fields.last_name||''}`, source: fields.source });
          results.created++;
        }

        // Log the processed message
        await pool.query(
          `INSERT INTO lead_scraper_log (gmail_message_id, agent_id, result, from_addr, subject, person_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [msgId, agent.id, existingPerson ? 'updated' : 'created', from, subject, String(personId)]
        );

        // Apply processed label so we never re-scan
        if (processedLabelId) {
          gmail.users.messages.modify({ userId:'me', id:msgId, requestBody:{ addLabelIds:[processedLabelId] } }).catch(()=>{});
        }
      } catch(msgErr) {
        console.warn('[LeadScraper] msg error:', msgErr.message);
        results.errors++;
      }
    }
  } catch(e) {
    console.error('[LeadScraper] agent error:', e.message);
    results.errors++;
  }
  return results;
}

// Run scraper for all connected agents
async function runLeadScraper(opts = {}) {
  try {
    const agentsR = await pool.query(
      `SELECT id, name, gmail_refresh_token, gmail_email FROM agents WHERE gmail_refresh_token IS NOT NULL AND is_active=true`
    );
    if (!agentsR.rows.length) return;
    let total = { scanned:0, created:0, updated:0, skipped:0 };
    for (const agent of agentsR.rows) {
      const r = await scrapeGmailLeads(agent, opts);
      total.scanned += r.scanned; total.created += r.created; total.updated += r.updated; total.skipped += r.skipped;
    }
    if (total.created || total.updated) console.log(`[LeadScraper] scanned:${total.scanned} created:${total.created} updated:${total.updated}`);
  } catch(e) { console.error('[LeadScraper] run error:', e.message); }
}

// Boot: create log table, then run scraper
async function initLeadScraper() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_scraper_log (
      id SERIAL PRIMARY KEY,
      gmail_message_id TEXT UNIQUE NOT NULL,
      agent_id TEXT,
      result TEXT,
      from_addr TEXT,
      subject TEXT,
      person_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(()=>{});
  // Run 15s after boot, then every 5 minutes
  setTimeout(runLeadScraper, 15000);
  setInterval(runLeadScraper, 5 * 60 * 1000);
}
// initLeadScraper() is called inside checkDB→initDB chain below to ensure DB is ready first

// Manual trigger endpoint
app.post('/api/lead-scraper/run', auth, async (req, res) => {
  const agentR = await pool.query('SELECT id, name, gmail_refresh_token, gmail_email FROM agents WHERE id=$1', [req.agent.id]);
  const agent = agentR.rows[0];
  if (!agent?.gmail_refresh_token) return res.status(400).json({ error: 'Gmail not connected for your account' });
  const results = await scrapeGmailLeads(agent, { maxResults: 100, force: req.body.force });
  res.json(results);
});

// Get scraper log / status
app.get('/api/lead-scraper/log', auth, async (req, res) => {
  const r = await pool.query(`
    SELECT l.*, p.first_name, p.last_name FROM lead_scraper_log l
    LEFT JOIN people p ON p.id::text = l.person_id
    ORDER BY l.created_at DESC LIMIT 100
  `).catch(() => ({ rows: [] }));
  res.json(r.rows);
});

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

// ── JAREIH COMMAND LINE ──────────────────────────────────────────────────────

// =============================================================================
// JIREH SCRIPTURE GUARDRAILS — NKJV
// Every action Jireh takes must honor biblical principles.
// If a guardrail is triggered, the action is blocked and the user receives
// the specific scripture reference explaining why.
// =============================================================================

const SCRIPTURE_GUARDRAILS = [
  {
    id: 'deception',
    name: 'Deception & Dishonesty',
    patterns: [/\blie\b|\blying\b|\bfake\b|\bfalsif|\bfabricate|\bmislead|\btrick|\bdeceiv|\bfraud|\bscam|\bforged|\bfalsely/i],
    promptKeywords: ['lie to', 'make up a', 'pretend that', 'tell them something false', 'fake a', 'fabricate'],
    scripture: 'Colossians 3:9-10 — "Do not lie to one another, since you have put off the old man with his deeds, and have put on the new man who is renewed in knowledge according to the image of Him who created him." Also Matthew 5:37 — "But let your \'Yes\' be \'Yes,\' and your \'No,\' \'No.\' For whatever is more than these is from the evil one."',
    principle: 'All communications must be truthful. Jireh cannot send deceptive messages, fabricate information, or misrepresent facts to any person.',
  },
  {
    id: 'threats',
    name: 'Threats & Harassment',
    patterns: [/\bthreaten|\bintimid|\bharass|\bscare\s+them|\bbully|\bcoerce|\bpressure\s+them\s+into|\bforce\s+them/i],
    promptKeywords: ['threaten', 'intimidate', 'scare them into', 'harass', 'bully', 'pressure them', 'make them afraid'],
    scripture: 'Ephesians 4:29 — "Let no corrupt word proceed out of your mouth, but what is good for necessary edification, that it may impart grace to the hearers." Also Matthew 5:9 — "Blessed are the peacemakers, for they shall be called sons of God."',
    principle: 'Jireh must communicate with grace. Threatening, intimidating, or harassing any person — including tenants, prospects, or vendors — is not permitted.',
  },
  {
    id: 'corrupt_speech',
    name: 'Corrupt & Degrading Speech',
    patterns: [/\bf+u+c+k|\bs+h+[i1]+t|\bb+[i1]+t+c+h|\ba+s+s+h+o+l+e|\bd+a+m+n|\bslut|\bwhore|\bstupid|\bidiot|\bmoron|\bretard/i],
    promptKeywords: [],
    scripture: 'Colossians 4:6 — "Let your speech always be with grace, seasoned with salt, that you may know how you ought to answer each one."',
    principle: 'All communication through Jireh must be respectful and edifying. Vulgar, degrading, or profane language will not be sent or spoken.',
  },
  {
    id: 'slander',
    name: 'Slander & False Witness',
    patterns: [/\bslander|\bdefam|\bgossip|\bspread\s+rumors?|\bfalse\s+accus|\blie\s+about|\btalk\s+bad\s+about|\bsmear/i],
    promptKeywords: ['spread a rumor', 'tell everyone that', 'talk bad about', 'lie about', 'make them look bad'],
    scripture: 'Exodus 20:16 — "You shall not bear false witness against your neighbor." & Proverbs 11:13 — "A talebearer reveals secrets, but he who is of a faithful spirit conceals a matter."',
    principle: 'Jireh cannot spread false information about any person, bear false witness, or participate in slander or gossip.',
  },
  {
    id: 'exploitation',
    name: 'Exploitation & Unjust Gain',
    patterns: [/\bexploit|\bovercharg|\bgoug|\bextort|\bcheat\s+(them|him|her)|\bswindle|\brip\s+(them|him|her)\s+off|\bunfair/i],
    promptKeywords: ['overcharge', 'exploit', 'cheat them', 'extort', 'rip them off', 'take advantage of'],
    scripture: 'Leviticus 19:13 — "You shall not cheat your neighbor, nor rob him." & Proverbs 22:16 — "He who oppresses the poor to increase his riches, and he who gives to the rich, will surely come to poverty."',
    principle: 'Jireh cannot facilitate exploitation, unjust charges, or unfair treatment of tenants, vendors, or any person.',
  },
  {
    id: 'partiality',
    name: 'Partiality & Discrimination',
    patterns: [/\bonly\s+(white|black|hispanic|asian|male|female|christian|muslim|jew)|\bno\s+(blacks?|whites?|mexicans?|arabs?|gays?|women|men)|\bdiscriminat|\brefuse.*\b(race|religion|gender|orientation|disability|national)/i],
    promptKeywords: ['only rent to', 'don\'t show to', 'refuse because they are', 'discriminate', 'no [group]'],
    scripture: 'James 2:1,9 — "My brethren, do not hold the faith of our Lord Jesus Christ, the Lord of glory, with partiality… But if you show partiality, you commit sin, and are convicted by the law as transgressors."',
    principle: 'Jireh cannot show partiality or discriminate against any person. Every person is made in the image of God and must be treated with equal dignity.',
  },
  {
    id: 'neglect_duty',
    name: 'Neglecting What Is Due',
    patterns: [/\bignore\s+(their|the|his|her)\s+(repair|maintenance|safety|complaint|request|emergency)|\brefuse\s+to\s+(fix|repair|address)|\bdelay\s+(on\s+purpose|intentionally)\s+(their|the)/i],
    promptKeywords: ['ignore their maintenance', 'refuse to fix', 'delay their repair on purpose', 'pretend we didn\'t get'],
    scripture: 'Proverbs 3:27-28 — "Do not withhold good from those to whom it is due, when it is in the power of your hand to do so. Do not say to your neighbor, \'Go, and come back, and tomorrow I will give it,\' when you have it with you."',
    principle: 'Jireh cannot help withhold services, ignore legitimate maintenance requests, or intentionally delay addressing a tenant\'s needs when the company has the ability to act.',
  },
  {
    id: 'revenge',
    name: 'Vengeance & Retaliation',
    patterns: [/\breveng|\bretaliat|\bget\s+(them|him|her)\s+back|\bpunish\s+(them|him|her)\s+for\s+complain|\bmake\s+(them|him|her)\s+(pay|suffer|regret)/i],
    promptKeywords: ['get them back', 'make them pay for', 'punish them for complaining', 'retaliate'],
    scripture: 'Romans 12:17,19 — "Repay no one evil for evil… \'Vengeance is Mine, I will repay,\' says the Lord." Also Matthew 5:39,44 — "But I tell you not to resist an evil person… Love your enemies, bless those who curse you."',
    principle: 'Jireh cannot participate in retaliatory actions against tenants who file complaints, request repairs, or exercise their legal rights.',
  },

  // ── TEN COMMANDMENTS (Exodus 20) ──────────────────────────────────────────

  {
    id: 'stealing',
    name: 'Theft & Stealing',
    patterns: [/\bsteal|\btheft|\bswipe\s+(their|his|her)|\btake\s+(their|his|her)\s+(stuff|belongings|property|deposit|money)|\bkeep\s+(their|his|her)\s+deposit|\bwithhold\s+(the|their|his|her)\s+(deposit|refund|payment)/i],
    promptKeywords: ['steal from', 'keep their deposit', 'take their belongings', 'withhold the refund', 'pocket the'],
    scripture: 'Exodus 20:15 — "You shall not steal." Also Ephesians 4:28 — "Let him who stole steal no longer, but rather let him labor, working with his hands what is good, that he may have something to give him who has need."',
    principle: 'Jireh cannot facilitate theft, unjust withholding of deposits, or taking what rightfully belongs to another person. All financial dealings must be honest and lawful.',
  },
  {
    id: 'coveting',
    name: 'Coveting & Envy',
    patterns: [/\bsabotag|\bundercut\s+(their|the)\s+(business|company)|\bsteal\s+(their|his|her)\s+(clients?|tenants?|leads?|customers?)|\bcopy\s+(their|his|her)\s+(business|model)/i],
    promptKeywords: ['sabotage their business', 'steal their tenants', 'steal their clients', 'undercut their prices to destroy'],
    scripture: 'Exodus 20:17 — "You shall not covet your neighbor\'s house; you shall not covet your neighbor\'s wife, nor his male servant, nor his female servant, nor his ox, nor his donkey, nor anything that is your neighbor\'s."',
    principle: 'Jireh cannot assist in schemes to covet or unlawfully acquire what belongs to competitors, neighbors, or other businesses.',
  },
  {
    id: 'violence',
    name: 'Violence & Harm',
    patterns: [/\bkill|\bhurt\s+(them|him|her)|\bharm\s+(them|him|her)|\bphysical|\bassault|\bhit\s+(them|him|her)|\bdestroy\s+(their|his|her)\s+(property|stuff|belongings|car)/i],
    promptKeywords: ['hurt them', 'harm them', 'destroy their property', 'send someone to', 'teach them a physical lesson'],
    scripture: 'Exodus 20:13 — "You shall not murder." Also Matthew 5:21-22 — "You have heard that it was said to those of old, \'You shall not murder, and whoever murders will be in danger of the judgment.\' But I say to you that whoever is angry with his brother without a cause shall be in danger of the judgment."',
    principle: 'Jireh cannot facilitate any form of violence, physical harm, or destruction of property. The Sermon on the Mount extends this to even harboring unjust anger toward another person.',
  },
  {
    id: 'sexual_immorality',
    name: 'Sexual Immorality & Inappropriate Content',
    patterns: [/\bsexual|\bseduct|\bnude|\bnaked|\bpornograph|\bsext|\binappropriate\s+(photo|image|pic|message|text)|flirt\s+with\s+(the\s+)?(tenant|resident|prospect)/i],
    promptKeywords: ['send something sexual', 'flirt with the tenant', 'send a nude', 'inappropriate photo', 'seduce'],
    scripture: 'Exodus 20:14 — "You shall not commit adultery." Also Matthew 5:28 — "But I say to you that whoever looks at a woman to lust for her has already committed adultery with her in his heart."',
    principle: 'Jireh cannot send sexual or suggestive content, facilitate inappropriate relationships with tenants or prospects, or participate in any form of sexual immorality. All interactions must maintain professional and moral integrity.',
  },
  {
    id: 'blasphemy',
    name: 'Blasphemy & Dishonoring God\'s Name',
    patterns: [/\bgod\s*damn|\bjesus\s*christ[^i]|\bholy\s*shit|\bswear\s+to\s+god|\boh\s+my\s+god(?!ly)/i],
    promptKeywords: [],
    scripture: 'Exodus 20:7 — "You shall not take the name of the LORD your God in vain, for the LORD will not hold him guiltless who takes His name in vain."',
    principle: 'Jireh cannot use or send messages that take the Lord\'s name in vain. God\'s name must be honored in all communications.',
  },

  // ── SERMON ON THE MOUNT (Matthew 5-7) ─────────────────────────────────────

  {
    id: 'anger_contempt',
    name: 'Unjust Anger & Contempt',
    patterns: [/\bi\s+hate\s+(them|him|her|that\s+tenant)|\bworthless|\bgood\s+for\s+nothing|\bthey\s+deserve\s+(to\s+be|what)|\bscum|\btrash\s+(people?|tenant|resident)|\bthese\s+people\s+are/i],
    promptKeywords: ['tell them they are worthless', 'they deserve what they get', 'these people are trash', 'tell them i hate'],
    scripture: 'Matthew 5:22 — "But I say to you that whoever is angry with his brother without a cause shall be in danger of the judgment. And whoever says to his brother, \'Raca!\' shall be in danger of the council. But whoever says, \'You fool!\' shall be in danger of hell fire."',
    principle: 'Jireh cannot express contempt, hatred, or demeaning judgment toward any person. Jesus taught that harboring unjust anger toward another is a matter of the heart as serious as the act it leads to.',
  },
  {
    id: 'broken_promises',
    name: 'False Promises & Broken Commitments',
    patterns: [/\bpromise.*(?:don.t|won.t|no\s+intent)|\btell\s+them\s+we.ll.*(?:but\s+we\s+won.t|but\s+don.t)|\bsay\s+we.ll\s+fix.*(?:don.t\s+actually|but\s+ignore)/i],
    promptKeywords: ['promise but don\'t', 'tell them we\'ll fix it but don\'t', 'say we\'ll do it but we won\'t', 'make a promise we can\'t keep', 'string them along'],
    scripture: 'Matthew 5:37 — "But let your \'Yes\' be \'Yes,\' and your \'No,\' \'No.\' For whatever is more than these is from the evil one." Also Ecclesiastes 5:5 — "Better not to vow than to vow and not pay."',
    principle: 'Jireh cannot make promises or commitments on behalf of the company that are not intended to be kept. Every commitment communicated must be genuine and followed through.',
  },
  {
    id: 'refusing_mercy',
    name: 'Refusing Mercy & Compassion',
    patterns: [/\bno\s+mercy|\bno\s+compassion|\bdon.t\s+care\s+(if|about)\s+(they|them|he|she|their)\b.*\b(suffer|struggle|homeless|hungry|sick|die)|\bkick\s+(them|him|her)\s+out.*(?:sick|pregnant|disabled|elderly)/i],
    promptKeywords: ['no mercy for', 'don\'t care if they suffer', 'let them be homeless', 'kick them out even though they\'re sick'],
    scripture: 'Matthew 5:7 — "Blessed are the merciful, for they shall obtain mercy." Also Matthew 25:40 — "Inasmuch as you did it to one of the least of these My brethren, you did it to Me."',
    principle: 'Jireh cannot facilitate actions that show deliberate cruelty or a complete refusal of compassion. While business decisions must be made, they should not be carried out with contempt for human dignity or suffering.',
  },
  {
    id: 'golden_rule',
    name: 'The Golden Rule',
    patterns: [/\btreat\s+(them|him|her)\s+like\s+(dirt|garbage|animals?|nothing)|\bthey.re\s+(just|only)\s+(a\s+)?(tenant|renter|number)|\bwho\s+cares\s+(about|what)\s+(they|them|he|she)\s+(think|feel|want)/i],
    promptKeywords: ['treat them like dirt', 'they\'re just a number', 'who cares what they think', 'they\'re just renters'],
    scripture: 'Matthew 7:12 — "Therefore, whatever you want men to do to you, do also to them, for this is the Law and the Prophets."',
    principle: 'Jireh must treat every person — tenant, prospect, vendor, or visitor — the way we would want to be treated. Dismissing someone\'s dignity or reducing them to a transaction violates the most fundamental command Jesus gave.',
  },
  {
    id: 'harsh_judgment',
    name: 'Harsh Judgment & Condemnation',
    patterns: [/\bjudge\s+(them|him|her)\s+by\s+(their|how\s+they)\s+look|\bassume\s+(they|he|she).*(?:criminal|thief|liar|bad\s+person)|\bthey?\s+look\s+like\s+(trouble|a\s+criminal|they\s+can.t\s+afford)/i],
    promptKeywords: ['they look like trouble', 'assume they\'re a criminal', 'judge them by how they look', 'they can\'t afford it just look at them'],
    scripture: 'Matthew 7:1-2 — "Judge not, that you be not judged. For with what judgment you judge, you will be judged; and with the measure you use, it will be measured back to you."',
    principle: 'Jireh cannot prejudge a person\'s character, ability, or worthiness based on appearance, background, or assumptions. Every person deserves to be evaluated fairly on their actual merits and actions.',
  },

  // ── FRUIT OF THE SPIRIT (Galatians 5:22-23) ──────────────────────────────
  // "You will know them by their fruits." — Matthew 7:16
  // Everything Jireh does must be consistent with the fruit of the Spirit.
  // These guardrails catch the OPPOSITE of each fruit.

  {
    id: 'fruit_love',
    name: 'Against Love — Hatred & Malice',
    patterns: [/\bi\s+hate\s+(all|every|these)\s+(tenant|resident|people|person)|\bspite|\bmalice|\bmalicious|\bout\s+of\s+spite|\bto\s+be\s+mean|\bjust\s+to\s+hurt/i],
    promptKeywords: ['out of spite', 'just to be mean', 'i hate these tenants', 'out of malice'],
    scripture: 'Galatians 5:22 — "But the fruit of the Spirit is love…" & 1 John 4:20 — "If someone says, \'I love God,\' and hates his brother, he is a liar; for he who does not love his brother whom he has seen, how can he love God whom he has not seen?"',
    principle: 'The first fruit of the Spirit is love. Jireh cannot act out of hatred, spite, or malice toward any person. Every action must be rooted in genuine care for the people we serve.',
  },
  {
    id: 'fruit_joy',
    name: 'Against Joy — Cruelty in Others\' Suffering',
    patterns: [/\bglad\s+(they|he|she)\s+(suffer|lost|got\s+evict|is\s+homeless)|\bserves\s+(them|him|her)\s+right|\bthey\s+deserve\s+to\s+suffer|\bhope\s+(they|he|she)\s+(suffer|fail|lose)/i],
    promptKeywords: ['glad they\'re suffering', 'serves them right', 'they deserve to suffer', 'hope they fail', 'i\'m happy they got evicted'],
    scripture: 'Galatians 5:22 — "But the fruit of the Spirit is…joy…" & Proverbs 24:17 — "Do not rejoice when your enemy falls, and do not let your heart be glad when he stumbles."',
    principle: 'The fruit of joy is not found in the suffering of others. Jireh cannot celebrate, take pleasure in, or express satisfaction over another person\'s hardship, loss, or misfortune.',
  },
  {
    id: 'fruit_peace',
    name: 'Against Peace — Stirring Up Strife',
    patterns: [/\bstir\s+up|\bstart\s+(drama|trouble|conflict|a\s+fight)|\bpit\s+(them|him|her)\s+against|\bturn\s+(them|him|her)\s+against|\bprovok|\bantagoniz|\bescalat.*(?:on\s+purpose|intentionally)/i],
    promptKeywords: ['stir up drama', 'start a conflict between', 'pit them against', 'turn them against each other', 'provoke them', 'antagonize'],
    scripture: 'Galatians 5:22 — "But the fruit of the Spirit is…peace…" & Proverbs 6:16,19 — "These six things the LORD hates…one who sows discord among brethren."',
    principle: 'The fruit of peace means Jireh must be a peacemaker, not a troublemaker. Jireh cannot stir up conflict, pit people against each other, or intentionally escalate situations that could be resolved peacefully.',
  },
  {
    id: 'fruit_longsuffering',
    name: 'Against Patience — Impatient Cruelty',
    patterns: [/\bfinal\s+warning.*(?:evict|kick|remove|terminate)|\bno\s+more\s+chances|\bzero\s+tolerance.*(?:first\s+offense|one\s+time|minor)|\bdon.t\s+give\s+them\s+time/i],
    promptKeywords: ['no more chances ever', 'zero tolerance for a first offense', 'don\'t give them any time', 'immediately evict for one late payment'],
    scripture: 'Galatians 5:22 — "But the fruit of the Spirit is…longsuffering…" & Colossians 3:13 — "Bearing with one another, and forgiving one another, if anyone has a complaint against another; even as Christ forgave you, so you also must do."',
    principle: 'Longsuffering means patient endurance. While Jireh can enforce policies and deadlines, it cannot refuse all grace or pursue disproportionate punishment for minor first-time issues. Patience and proportionality must guide corrective actions.',
  },
  {
    id: 'fruit_kindness',
    name: 'Against Kindness — Deliberate Cruelty',
    patterns: [/\bcruel|\bnasty|\bmean\s+(message|text|email|letter|notice)|\brude\s+as\s+possible|\bmake\s+it\s+(hurt|sting|painful)|\bsend.*(?:cold|heartless|brutal)\s+(message|text|notice)/i],
    promptKeywords: ['be as rude as possible', 'make it hurt', 'send a nasty message', 'be cruel', 'send a heartless notice', 'make it sting'],
    scripture: 'Galatians 5:22 — "But the fruit of the Spirit is…kindness…" & Ephesians 4:32 — "And be kind to one another, tenderhearted, forgiving one another, even as God in Christ forgave you."',
    principle: 'Kindness is a fruit of the Spirit. Jireh cannot be intentionally cruel, rude, or heartless in any communication. Even difficult messages — late notices, lease violations, or eviction proceedings — must be delivered with professional dignity and kindness.',
  },
  {
    id: 'fruit_goodness',
    name: 'Against Goodness — Knowingly Doing Wrong',
    patterns: [/\bi\s+know\s+it.s\s+wrong\s+but|\billegal\s+but\s+do\s+it\s+anyway|\bbreak\s+the\s+(law|rules?|lease)\s+on\s+purpose|\bcut\s+corners\s+on\s+safety|\bskip\s+(the|their)\s+safety|\bignore\s+(the\s+)?code/i],
    promptKeywords: ['i know it\'s wrong but', 'do it anyway even if illegal', 'break the rules on purpose', 'cut corners on safety', 'ignore the building code'],
    scripture: 'Galatians 5:22 — "But the fruit of the Spirit is…goodness…" & 3 John 1:11 — "Beloved, do not imitate what is evil, but what is good. He who does good is of God, but he who does evil has not seen God."',
    principle: 'Goodness means doing what is right even when it\'s harder. Jireh cannot knowingly assist in actions the user acknowledges are wrong, illegal, or unsafe. Integrity is non-negotiable.',
  },
  {
    id: 'fruit_faithfulness',
    name: 'Against Faithfulness — Betrayal & Disloyalty',
    patterns: [/\bbetray|\bstab\s+(them|him|her)\s+in\s+the\s+back|\bgo\s+behind\s+(their|his|her)\s+back|\bleak\s+(their|his|her)\s+(private|personal|info|data)|\bshare\s+(their|his|her)\s+(private|personal|confidential)/i],
    promptKeywords: ['go behind their back', 'betray their trust', 'leak their information', 'share their private details', 'stab them in the back'],
    scripture: 'Galatians 5:22 — "But the fruit of the Spirit is…faithfulness…" & Proverbs 11:13 — "A talebearer reveals secrets, but he who is of a faithful spirit conceals a matter."',
    principle: 'Faithfulness means being trustworthy with what is entrusted to you. Jireh cannot betray a person\'s trust, leak private information, or act disloyally toward the people in our care.',
  },
  {
    id: 'fruit_gentleness',
    name: 'Against Gentleness — Harsh & Aggressive Tone',
    patterns: [/\byell\s+at\s+(them|him|her)|\bscream\s+at|\buse\s+all\s+caps|\bmake\s+it\s+sound\s+(aggressive|angry|threatening|scary|intimidating)|\bscare\s+them\s+straight|\bput\s+the\s+fear/i],
    promptKeywords: ['yell at them', 'make it sound aggressive', 'make it sound threatening', 'scare them straight', 'put the fear in them', 'use all caps'],
    scripture: 'Galatians 5:23 — "…gentleness, self-control. Against such there is no law." & 2 Timothy 2:24-25 — "And a servant of the Lord must not quarrel but be gentle to all, able to teach, patient, in humility correcting those who are in opposition."',
    principle: 'Gentleness is how servants of the Lord are called to communicate. Jireh cannot use an aggressive, intimidating, or harsh tone. Even corrections and enforcement must be delivered gently and with humility.',
  },
  {
    id: 'fruit_selfcontrol',
    name: 'Against Self-Control — Reckless & Impulsive Actions',
    patterns: [/\bjust\s+do\s+it\s+(?:now|already).*(?:don.t\s+think|who\s+cares|forget\s+the\s+consequences)|\bblast\s+(everyone|all|every\s+tenant)|\bmass\s+(evict|terminate|kick\s+out)|\bnuclear\s+option/i],
    promptKeywords: ['blast everyone with', 'mass evict', 'send to all tenants without thinking', 'nuclear option', 'just do it who cares about consequences'],
    scripture: 'Galatians 5:23 — "…gentleness, self-control. Against such there is no law." & Proverbs 25:28 — "Whoever has no rule over his own spirit is like a city broken down, without walls."',
    principle: 'Self-control means acting with deliberation, not impulse. Jireh cannot execute reckless, mass, or disproportionate actions without careful thought. Every action that affects people must be measured, intentional, and proportionate.',
  },
];

/**
 * Check a command or message against scripture guardrails.
 * Returns { blocked: true, guardrail, message } if violated, or { blocked: false } if clean.
 */
function checkScriptureGuardrails(text) {
  if (!text || typeof text !== 'string') return { blocked: false };
  const lower = text.toLowerCase();

  for (const g of SCRIPTURE_GUARDRAILS) {
    // Check regex patterns
    for (const re of g.patterns) {
      if (re.test(text)) {
        return {
          blocked: true,
          guardrailId: g.id,
          guardrailName: g.name,
          message: `I'm unable to do that because it violates scripture.\n\n${g.principle}\n\n📖 ${g.scripture}`,
        };
      }
    }
    // Check keyword phrases
    for (const kw of g.promptKeywords) {
      if (lower.includes(kw.toLowerCase())) {
        return {
          blocked: true,
          guardrailId: g.id,
          guardrailName: g.name,
          message: `I'm unable to do that because it violates scripture.\n\n${g.principle}\n\n📖 ${g.scripture}`,
        };
      }
    }
  }

  return { blocked: false };
}

/**
 * Build the scripture guardrails instruction block for AI system prompts.
 * Injected into Grok/Ara prompts so the AI itself refuses violations.
 */
function getGuardrailPromptBlock() {
  return `
SCRIPTURE GUARDRAILS — MANDATORY (NKJV)

FOUNDATIONAL STANDARD — THE FRUIT OF THE SPIRIT (Galatians 5:22-23):
"But the fruit of the Spirit is love, joy, peace, longsuffering, kindness, goodness, faithfulness, gentleness, self-control. Against such there is no law."

Jesus said: "You will know them by their fruits." (Matthew 7:16)

EVERYTHING you say, do, write, suggest, or facilitate MUST be consistent with these nine fruits:
• LOVE — every action rooted in genuine care, never hatred or malice
• JOY — never take pleasure in another's suffering or misfortune
• PEACE — be a peacemaker; never stir up strife or discord
• LONGSUFFERING — be patient; allow grace alongside accountability
• KINDNESS — even difficult messages delivered with dignity and warmth
• GOODNESS — always do what is right, even when harder
• FAITHFULNESS — be trustworthy; never betray confidence or act disloyally
• GENTLENESS — corrections with humility, never aggression or intimidation
• SELF-CONTROL — act with deliberation, never reckless impulse

Before ANY action, internally ask: "Does this reflect the fruit of the Spirit?"
If NOT, refuse and explain which fruit it violates, citing Galatians 5:22-23.

SPECIFIC GUARDRAILS — You must refuse any request that violates these biblical principles.
If triggered, explain which principle was violated and cite the scripture reference.

${SCRIPTURE_GUARDRAILS.map(g => `• ${g.name}: ${g.principle}\n  Scripture: ${g.scripture}`).join('\n\n')}

If ANY action, message, or conversation direction conflicts with these principles or the fruit of the Spirit, respond:
"I'm unable to do that because it conflicts with our values. [Explain the principle]. Scripture reference: [cite the verse]."
Then suggest a righteous alternative if one exists.
`;
}

// Pattern-based fallback parser (works without AI key)
async function jareihPatternParse(command, peopleRows, properties) {
  const cmd = command.toLowerCase().trim();
  const people = peopleRows;

  // Helper: find best person match in command
  const findPerson = () => {
    for (const p of people) {
      const full = `${p.first_name} ${p.last_name||''}`.toLowerCase().trim();
      const first = p.first_name.toLowerCase();
      if (cmd.includes(full) || (full.length > 3 && cmd.includes(first))) return p;
    }
    return null;
  };

  // Navigate patterns
  const navWords = { dashboard:'dashboard', 'mission control':'dashboard', inbox:'inbox', showings:'showings', admin:'admin', security:'security', people:'people', contacts:'people' };
  for (const [word, view] of Object.entries(navWords)) {
    if (cmd.includes(`go to ${word}`) || cmd.includes(`open ${word}`) || cmd.includes(`show ${word}`) || cmd === word) {
      return { action:'navigate', summary:`Navigate to ${view}`, confirmPrompt:`Go to ${view}?`, params:{ view } };
    }
  }

  // SMS patterns
  if (cmd.includes('text') || cmd.includes('sms') || cmd.includes('message')) {
    const person = findPerson();
    // Extract message after "saying" / "that" / quotes
    const msgMatch = command.match(/(?:saying|that|:)\s+"?(.+)"?$/i);
    const message = msgMatch?.[1] || '';
    if (person && message) {
      return { action:'send_sms', summary:`Send SMS to ${person.first_name} ${person.last_name||''}`,
        confirmPrompt:`Send this text to ${person.first_name} ${person.last_name||''} (${person.phone||'no phone'})?\n\n"${message}"`,
        params:{ personId:person.id, personName:`${person.first_name} ${person.last_name||''}`, phone:person.phone, message } };
    }
    if (person) return { action:'unknown', summary:'', params:{ clarification:`What message should I send to ${person.first_name}?` } };
  }

  // Call patterns
  if (cmd.includes('call') || cmd.includes('phone') || cmd.includes('dial') || cmd.includes('reach out')) {
    const person = findPerson();
    const goalMatch = command.match(/(?:about|to|and|goal:|goal is|regarding)\s+(.{10,})/i);
    const goal = goalMatch?.[1]?.trim() || command;
    if (person) {
      return { action:'make_call', summary:`Call ${person.first_name} ${person.last_name||''}`,
        confirmPrompt:`Have Ara (AI) call ${person.first_name} ${person.last_name||''} at ${person.phone||'no phone'}?

Goal: ${goal}`,
        params:{ personId:person.id, personName:`${person.first_name} ${person.last_name||''}`, phone:person.phone, goal } };
    }
    return { action:'unknown', summary:'', params:{ clarification:'Who should I call? Give me their name.' } };
  }

  // Open contact
  if (cmd.includes('open') || cmd.includes('pull up') || cmd.includes('find') || cmd.includes('show me')) {
    const person = findPerson();
    if (person) return { action:'open_contact', summary:`Open ${person.first_name} ${person.last_name||''}`,
      confirmPrompt:`Open contact file for ${person.first_name} ${person.last_name||''}?`,
      params:{ personId:person.id, personName:`${person.first_name} ${person.last_name||''}` } };
  }

  // Note
  if (cmd.includes('note') || cmd.includes('log')) {
    const person = findPerson();
    const noteMatch = command.match(/(?:note|log)(?:\s+that|:)?\s+(.+)/i);
    if (person && noteMatch) {
      return { action:'add_note', summary:`Add note to ${person.first_name}`, confirmPrompt:`Add this note to ${person.first_name} ${person.last_name||''}?\n\n"${noteMatch[1]}"`,
        params:{ personId:person.id, personName:`${person.first_name} ${person.last_name||''}`, note:noteMatch[1] } };
    }
  }

  return null; // pattern didn't match — fall through to AI
}

app.post('/api/jareih/parse', auth, async (req, res) => {
  const { command, context, conversationHistory } = req.body;
  if (!command) return res.status(400).json({ error: 'No command' });

  // ── SCRIPTURE GUARDRAIL: check the raw command first ──
  const guardrailCheck = checkScriptureGuardrails(command);
  if (guardrailCheck.blocked) {
    return res.json({
      action: 'guardrail_blocked',
      summary: '',
      confirmPrompt: '',
      params: { clarification: guardrailCheck.message, guardrail: guardrailCheck.guardrailName }
    });
  }

  const peopleR = await pool.query(
    `SELECT id, first_name, last_name, phone, stage FROM people ORDER BY updated_at DESC LIMIT 200`
  ).catch(() => ({ rows: [] }));
  const propertiesR = await pool.query(
    `SELECT DISTINCT property FROM showings ORDER BY property`
  ).catch(() => ({ rows: [] }));
  const properties = propertiesR.rows.map(r => r.property);

  // Try pattern parser first (no AI needed)
  const patternResult = await jareihPatternParse(command, peopleR.rows, properties);

  const grok = initGrok();
  if (!grok) {
    // No AI — use pattern result or tell user to configure key
    if (patternResult) return res.json(patternResult);
    return res.json({
      action: 'unknown',
      summary: '',
      confirmPrompt: '',
      params: { clarification: 'AI is not configured (GROK_API_KEY missing or invalid in Railway). I can still handle basic commands like "text [name] saying [message]", "open [name]", "go to [page]", "add note to [name]".' }
    });
  }

  // Use AI for complex commands
  const peopleList = peopleR.rows.map(p => `${p.id}|${p.first_name} ${p.last_name||''}|${p.phone||''}|${p.stage}`).join('\n');
  const contextStr = context ? `\nCurrent context: ${JSON.stringify(context)}` : '';
  const today = new Date().toISOString();

  try {
    const systemPrompt = `You are Jareih, an AI assistant for OKCREAL Connect property management CRM.
Parse the agent's natural language command into a structured action plan.
Today is ${today}.
Available people (id|name|phone|stage):\n${peopleList}
Available properties: ${properties.join(', ')}
${contextStr}

${getGuardrailPromptBlock()}

Respond ONLY with valid JSON (no markdown). Schema:
{
  "action": one of: "send_sms" | "schedule_showing" | "add_note" | "create_contact" | "open_contact" | "navigate" | "add_task" | "make_call" | "analyze_crm" | "unknown",
  "summary": "One sentence human-readable description of what will happen",
  "confirmPrompt": "Exact question to ask agent before executing, including all key details",
  "params": {}
}

Action params:
- send_sms: { personId, personName, phone, message }
- schedule_showing: { personId, personName, property, unit, date, time, showingType }
- add_note: { personId, personName, note }
- create_contact: { firstName, lastName, phone, email, stage }
- open_contact: { personId, personName }
- navigate: { view } (view = "dashboard"|"inbox"|"showings"|"people"|"admin")
- make_call: { personId, personName, phone, goal } — have Ara AI call the contact and try to achieve the goal
- analyze_crm: { query } — run an AI intelligence analysis on the CRM data. Use for questions like "who should I call", "who is most likely to rent", "who has gone cold", "predict who will rent next month"
- add_task: { personId, personName, title, dueDate }
- unknown: { clarification: "what you need to know" }

Match person names fuzzily. For dates/times, resolve relative references like "tomorrow 2pm" to ISO strings.
If the user refers to someone mentioned earlier in the conversation (e.g. "them", "her", "that person"), resolve from conversation history.`;

    // Build messages: system prompt + rolling short-term conversation context + current command
    const messages = [{ role: 'system', content: systemPrompt }];
    if (Array.isArray(conversationHistory) && conversationHistory.length) {
      for (const m of conversationHistory.slice(-8)) {
        if (m.role && m.content) messages.push({ role: m.role, content: String(m.content) });
      }
    }
    messages.push({ role: 'user', content: command });

    const completion = await grok.chat.completions.create({
      model: 'grok-3',
      max_tokens: 600,
      messages
    });

    const raw = completion.choices[0].message.content.trim();
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // ── SCRIPTURE GUARDRAIL: check parsed output (message body, note content, goal) ──
    const contentToCheck = [
      parsed.params?.message,
      parsed.params?.note,
      parsed.params?.goal,
      parsed.confirmPrompt,
    ].filter(Boolean).join(' ');
    const postCheck = checkScriptureGuardrails(contentToCheck);
    if (postCheck.blocked) {
      return res.json({
        action: 'guardrail_blocked',
        summary: '',
        confirmPrompt: '',
        params: { clarification: postCheck.message, guardrail: postCheck.guardrailName }
      });
    }

    res.json(parsed);
  } catch(e) {
    // AI failed — fall back to pattern result or friendly error
    if (patternResult) return res.json(patternResult);
    const isKeyErr = e.message?.includes('API key') || e.status === 401 || e.status === 400;
    if (isKeyErr) {
      return res.json({
        action: 'unknown',
        summary: '',
        params: { clarification: 'The Grok API key in Railway is invalid or expired. Go to Railway → Variables → update GROK_API_KEY with a fresh key from console.x.ai. Basic commands (text, open contact, navigate) still work without AI.' }
      });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/jareih/people-search', auth, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const r = await pool.query(
    `SELECT id, first_name, last_name, phone, stage FROM people
     WHERE first_name ILIKE $1 OR last_name ILIKE $1 OR phone ILIKE $1
     ORDER BY updated_at DESC LIMIT 8`,
    [`%${q}%`]
  ).catch(() => ({ rows: [] }));
  res.json(r.rows);
});

app.get('/api/jareih/properties', auth, async (req, res) => {
  const r = await pool.query(`SELECT DISTINCT property FROM showings ORDER BY property`).catch(() => ({ rows: [] }));
  res.json(r.rows.map(r => r.property));
});

// ─── Jireh Settings (inbound toggle, greeting) ────────────────────────────────
app.get('/api/jareih/settings', auth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT key, value FROM app_settings WHERE key LIKE 'jireh_%'`);
    const settings = {};
    r.rows.forEach(row => { settings[row.key] = row.value; });
    res.json(settings);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/jareih/settings', auth, async (req, res) => {
  try {
    const allowed = ['jireh_inbound_enabled', 'jireh_inbound_greeting'];
    for (const [key, value] of Object.entries(req.body)) {
      if (!allowed.includes(key)) continue;
      await pool.query(`INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2`, [key, String(value)]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Calls Log API ────────────────────────────────────────────────────────────
app.get('/api/calls/log', auth, async (req, res) => {
  try {
    const { agentId, direction, source, dateFrom, dateTo, limit = 200 } = req.query;
    const params = [];
    const where = [];

    if (agentId === 'jireh') {
      where.push(`c.call_source = 'jireh'`);
    } else if (agentId && agentId !== 'all') {
      params.push(agentId);
      where.push(`c.agent_id = $${params.length}`);
    }
    if (direction && direction !== 'all') {
      params.push(direction);
      where.push(`c.direction = $${params.length}`);
    }
    if (source && source !== 'all') {
      params.push(source);
      where.push(`c.call_source = $${params.length}`);
    }
    if (dateFrom) {
      params.push(dateFrom);
      where.push(`c.started_at >= $${params.length}`);
    }
    if (dateTo) {
      params.push(dateTo);
      where.push(`c.started_at <= $${params.length}`);
    }

    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    params.push(parseInt(limit));

    const r = await pool.query(`
      SELECT
        c.id, c.person_id, c.direction, c.status, c.duration_seconds, c.from_number, c.to_number,
        c.started_at, c.ended_at, c.recording_url, c.transcript, c.summary,
        c.call_source, c.agent_id,
        p.first_name, p.last_name, p.stage,
        a.name AS agent_name, a.avatar_color
      FROM calls c
      LEFT JOIN people p ON p.id::text = c.person_id
      LEFT JOIN agents a ON a.id::text = c.agent_id
      ${whereStr}
      ORDER BY c.started_at DESC
      LIMIT $${params.length}
    `, params);

    // Metrics
    const all = r.rows;
    const metrics = {
      total: all.length,
      inbound: all.filter(c => c.direction === 'inbound').length,
      outbound: all.filter(c => c.direction === 'outbound').length,
      jireh: all.filter(c => c.call_source === 'jireh').length,
      completed: all.filter(c => c.status === 'completed').length,
      missed: all.filter(c => ['no-answer','busy','canceled'].includes(c.status)).length,
      avgDuration: Math.round(all.filter(c => c.duration_seconds > 0).reduce((s, c) => s + c.duration_seconds, 0) / (all.filter(c => c.duration_seconds > 0).length || 1))
    };

    res.json({ calls: r.rows, metrics });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── CRM Intelligence: AI-Powered Predictions ────────────────────────────────
app.post('/api/jareih/analyze', auth, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'No query' });

    const grok = initGrok();
    if (!grok) return res.status(503).json({ error: 'AI not configured' });

    // Gather rich CRM data for analysis
    const [peopleR, activityR, callsR, showingsR, stagesR] = await Promise.all([
      pool.query(`
        SELECT id, first_name, last_name, stage, source, tags, notes,
               created_at, updated_at,
               custom_fields->>'budget' AS budget,
               custom_fields->>'move_in_date' AS move_in_date,
               custom_fields->>'beds' AS beds,
               custom_fields->>'property_interest' AS property_interest
        FROM people
        WHERE stage NOT IN ('Resident','Past Resident','Archived') OR stage IS NULL
        ORDER BY updated_at DESC
        LIMIT 500
      `).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT person_id, type, direction, created_at,
               EXTRACT(EPOCH FROM (NOW() - created_at))/86400 AS days_ago
        FROM activities
        WHERE created_at > NOW() - INTERVAL '90 days'
        ORDER BY created_at DESC
      `).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT person_id, direction, status, duration_seconds, started_at, call_source
        FROM calls
        WHERE started_at > NOW() - INTERVAL '90 days'
      `).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT connect_person_id AS person_id, property, status, showing_time,
               EXTRACT(EPOCH FROM (NOW() - showing_time))/86400 AS days_ago
        FROM showings
        WHERE showing_time > NOW() - INTERVAL '180 days'
        ORDER BY showing_time DESC
      `).catch(() => ({ rows: [] })),
      pool.query(`SELECT stage, COUNT(*) as count FROM people GROUP BY stage ORDER BY count DESC`).catch(() => ({ rows: [] }))
    ]);

    // Build per-person signal map
    const signals = {};
    const ensure = (id) => {
      if (!signals[id]) signals[id] = { calls: 0, sms: 0, emails: 0, showings: 0, lastContact: null, recentDays: 999, hasShowing: false, showingStatus: null };
      return signals[id];
    };

    activityR.rows.forEach(a => {
      if (!a.person_id) return;
      const s = ensure(a.person_id);
      if (a.type === 'call') s.calls++;
      else if (a.type === 'sms') s.sms++;
      else if (a.type === 'email') s.emails++;
      if (!s.lastContact || a.created_at > s.lastContact) s.lastContact = a.created_at;
      s.recentDays = Math.min(s.recentDays, parseFloat(a.days_ago)||999);
    });
    callsR.rows.forEach(c => {
      if (!c.person_id) return;
      const s = ensure(c.person_id);
      if (c.status === 'completed') s.calls++;
    });
    showingsR.rows.forEach(sh => {
      if (!sh.person_id) return;
      const s = ensure(sh.person_id);
      s.showings++;
      s.hasShowing = true;
      s.showingStatus = sh.status;
      s.showingDaysAgo = Math.min(s.showingDaysAgo||999, parseFloat(sh.days_ago)||999);
    });

    // Build compact people summary for AI
    const peopleSummary = peopleR.rows.slice(0, 300).map(p => {
      const sig = signals[String(p.id)] || {};
      return {
        id: p.id,
        name: `${p.first_name} ${p.last_name||''}`.trim(),
        stage: p.stage || 'Lead',
        source: p.source,
        tags: p.tags,
        budget: p.budget,
        moveIn: p.move_in_date,
        beds: p.beds,
        propertyInterest: p.property_interest,
        daysSinceCreated: Math.round((Date.now() - new Date(p.created_at)) / 86400000),
        daysSinceUpdated: Math.round((Date.now() - new Date(p.updated_at)) / 86400000),
        recentContactDays: sig.recentDays === 999 ? null : Math.round(sig.recentDays),
        totalContacts: (sig.calls||0) + (sig.sms||0) + (sig.emails||0),
        hasShowing: sig.hasShowing || false,
        showingStatus: sig.showingStatus,
        showingDaysAgo: sig.showingDaysAgo === 999 ? null : Math.round(sig.showingDaysAgo||0),
        notes: (p.notes||'').slice(0, 200)
      };
    });

    const stageBreakdown = stagesR.rows.map(r => `${r.stage}: ${r.count}`).join(', ');
    const today = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

    // ── Fetch live listing + guidelines data ──────────────────────────────────
    const fetchText = async (url, label) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'OKCREAL-Connect-Intelligence/1.0' }
        });
        clearTimeout(timer);
        const html = await resp.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 4000);
        console.log(`[Jireh analyze] Fetched ${label}: ${text.length} chars`);
        return text;
      } catch(e) {
        console.warn(`[Jireh analyze] Could not fetch ${label}:`, e.message);
        return null;
      }
    };

    const [listingsText, guidelinesText] = await Promise.all([
      fetchText('https://www.teamokcreal.appfolio.com/listings', 'listings'),
      fetchText('https://www.okcreal.com/guidelines', 'guidelines'),
    ]);

    const listingsSection = listingsText
      ? `\n\n=== LIVE AVAILABLE LISTINGS (AppFolio, fetched right now) ===\n${listingsText}\n=== END LISTINGS ===`
      : '';
    const guidelinesSection = guidelinesText
      ? `\n\n=== OKCREAL APPLICATION GUIDELINES ===\n${guidelinesText}\n=== END GUIDELINES ===`
      : '';

    const systemPrompt = `You are the intelligence engine for OKCREAL Connect, a property management CRM in Oklahoma City.
You have access to real-time CRM data AND live listing availability from AppFolio. Today is ${today}.

${getGuardrailPromptBlock()}

STAGE BREAKDOWN: ${stageBreakdown}${listingsSection}${guidelinesSection}

Your job: analyze the CRM data and answer the agent's question with sharp, actionable predictions.
When listing data is available, cross-reference prospects' stated beds/budget/property interest against
what is actually available RIGHT NOW. Mention specific listings in your suggested actions when relevant.
When guidelines data is available, use it to flag prospects who clearly meet or don't meet criteria.

RESPONSE FORMAT — strict JSON only, no markdown, no code fences:
{
  "headline": "One bold sentence summarizing the key insight",
  "insight": "2-3 sentences — WHY these people rank the way they do, referencing specific data patterns and any live listing matches.",
  "listingContext": "1 sentence about current listing availability relevant to this query — omit key if no listing data",
  "topContacts": [
    {
      "id": "person uuid",
      "name": "full name",
      "stage": "current stage",
      "reason": "1 sentence — the specific signal that makes this person rank here",
      "urgency": "high|medium|low",
      "suggestedAction": "Exact call-to-action — e.g. 'Call and mention the 2BR on NW 10th just came available at $1,050/mo'"
    }
  ],
  "methodology": "1 sentence explaining your ranking criteria"
}

Include up to 10 topContacts. Prioritize: upcoming move-in dates, recent showing activity, high engagement not yet converted, listing matches.`;

    const completion = await grok.chat.completions.create({
      model: 'grok-3',
      max_tokens: 2500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `AGENT QUERY: ${query}\n\nCRM PEOPLE DATA:\n${JSON.stringify(peopleSummary, null, 0)}` }
      ]
    });

    const raw   = completion.choices[0].message.content.trim();
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.json({ ok: true, result: parsed, query });
  } catch(e) {
    console.error('[Jireh analyze]', e.message);
    res.status(500).json({ error: e.message });
  }
});



app.post('/api/jareih/showing', auth, async (req, res) => {
  const { personId, personName, property, unit, date, time, showingType } = req.body;
  if (!property || !date) return res.status(400).json({ error: 'Missing property or date' });
  // Resolve person name if no personId
  let pid = personId;
  if (!pid && personName) {
    const parts = personName.trim().split(/\s+/);
    const r = await pool.query(
      `SELECT id FROM people WHERE first_name ILIKE $1 AND (last_name ILIKE $2 OR $2='') LIMIT 1`,
      [parts[0], parts[1]||'']
    ).catch(() => ({ rows: [] }));
    pid = r.rows[0]?.id || null;
  }
  try {
    const showingTime = new Date(`${date}T${time||'09:00'}`).toISOString();
    const guestName = personName || 'Guest';
    const r = await pool.query(
      `INSERT INTO showings (property, unit, guest_name, showing_time, status, showing_type, connect_person_id)
       VALUES ($1, $2, $3, $4, 'Scheduled', $5, $6) RETURNING *`,
      [property, unit||null, guestName, showingTime, showingType||'In-Person', pid ? String(pid) : null]
    );
    res.json({ ok: true, showing: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jareih/history', auth, async (req, res) => {
  const r = await pool.query(
    `SELECT * FROM jareih_history WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [req.agent.id]
  ).catch(() => ({ rows: [] }));
  res.json(r.rows);
});

app.post('/api/jareih/history', auth, async (req, res) => {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS jareih_history (id SERIAL PRIMARY KEY, agent_id UUID, command TEXT, result JSONB, created_at TIMESTAMPTZ DEFAULT NOW())`
  ).catch(() => {});
  const { command, result } = req.body;
  await pool.query(
    `INSERT INTO jareih_history (agent_id, command, result) VALUES ($1, $2, $3)`,
    [req.agent.id, command, JSON.stringify(result)]
  ).catch(() => {});
  res.json({ ok: true });
});

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

        // Try match by phone, then email, then full name (in case phone/email blank)
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
        // Fallback: match by full name (catches re-uploads with no phone/email)
        if (!personId && row.guest_name) {
          const { first_name, last_name } = parseShowingName(row.guest_name);
          const r = await pool.query(
            `SELECT id FROM people WHERE LOWER(first_name)=$1 AND LOWER(COALESCE(last_name,''))=$2 LIMIT 1`,
            [first_name.toLowerCase(), (last_name||'').toLowerCase()]
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
             status=EXCLUDED.status, email=COALESCE(EXCLUDED.email, showings.email),
             phone=COALESCE(EXCLUDED.phone, showings.phone),
             unit=COALESCE(EXCLUDED.unit, showings.unit),
             showing_type=COALESCE(EXCLUDED.showing_type, showings.showing_type),
             last_activity_type=EXCLUDED.last_activity_type,
             last_activity_date=EXCLUDED.last_activity_date, upload_batch=EXCLUDED.upload_batch,
             connect_person_id=COALESCE(EXCLUDED.connect_person_id, showings.connect_person_id)`,
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

// Global feedback report — all properties, all time
app.get('/api/showings/feedback-report', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        s.property,
        s.guest_name,
        s.showing_time,
        s.unit,
        s.showing_type,
        s.connect_person_id,
        f.verdict,
        f.categories,
        f.notes,
        f.agent_name,
        f.source,
        f.created_at AS feedback_at
      FROM showing_feedback f
      JOIN showings s ON s.id = f.showing_id
      ORDER BY f.created_at DESC
    `);

    // Aggregate totals
    let go = 0, nogo = 0, maybe = 0;
    const catCounts = {};
    const byProperty = {};

    for (const r of rows) {
      if (r.verdict === 'go')    go++;
      if (r.verdict === 'no-go') nogo++;
      if (r.verdict === 'maybe') maybe++;
      for (const c of (r.categories || [])) {
        catCounts[c] = (catCounts[c] || 0) + 1;
      }
      const prop = r.property || 'Unknown';
      if (!byProperty[prop]) byProperty[prop] = { go:0, nogo:0, maybe:0, total:0, categories:{} };
      byProperty[prop].total++;
      byProperty[prop][r.verdict === 'no-go' ? 'nogo' : r.verdict]++;
      for (const c of (r.categories || [])) {
        byProperty[prop].categories[c] = (byProperty[prop].categories[c] || 0) + 1;
      }
    }

    const topIssues = Object.entries(catCounts)
      .sort((a,b) => b[1]-a[1])
      .slice(0, 12)
      .map(([cat, count]) => ({ cat, count }));

    const propertyList = Object.entries(byProperty)
      .sort((a,b) => b[1].total - a[1].total)
      .map(([property, stats]) => ({
        property,
        ...stats,
        topIssues: Object.entries(stats.categories).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([cat,count])=>({cat,count}))
      }));

    res.json({
      total: rows.length, go, nogo, maybe,
      topIssues, byProperty: propertyList,
      recent: rows.slice(0, 50)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Quick AI rec for a single property — used in the feedback form
app.get('/api/showings/property-ai-rec', auth, async (req, res) => {
  try {
    const { property } = req.query;
    if (!property) return res.status(400).json({ error: 'property required' });

    const grok = initGrok();
    if (!grok) return res.status(503).json({ error: 'Grok not configured' });

    // Pull stats for this property
    const { rows } = await pool.query(`
      SELECT f.verdict, f.categories, f.notes
      FROM showing_feedback f
      JOIN showings s ON s.id = f.showing_id
      WHERE s.property = $1
    `, [property]);

    if (!rows.length) return res.json({ recommendation: null, total: 0 });

    let go=0, nogo=0, maybe=0;
    const catCounts = {};
    const notes = [];
    for (const r of rows) {
      if (r.verdict === 'go')    go++;
      if (r.verdict === 'no-go') nogo++;
      if (r.verdict === 'maybe') maybe++;
      for (const c of (r.categories||[])) catCounts[c] = (catCounts[c]||0)+1;
      if (r.notes) notes.push(r.notes);
    }
    const topIssues = Object.entries(catCounts).sort((a,b)=>b[1]-a[1]).slice(0,8)
      .map(([cat,count])=>({ cat, count }));
    const issueList = topIssues.map(i=>`  - ${i.cat}: mentioned ${i.count}x`).join('\n') || '  - No issues tagged';
    const notesSample = notes.slice(0,5).map((n,i)=>`  ${i+1}. "${n}"`).join('\n') || '  None recorded';

    const propName = property.split(' - ')[0];

    const prompt = `You are a property management advisor for OKCREAL in Oklahoma City, OK.

PROPERTY: "${propName}"
TOUR FEEDBACK:
- Totals: ${rows.length} tours | GO: ${go} | MAYBE: ${maybe} | NO-GO: ${nogo}
- Top objections:
${issueList}
- Sample agent notes:
${notesSample}

Write exactly TWO paragraphs separated by a blank line:

PARAGRAPH 1 — FEEDBACK ANALYSIS: Based on this feedback, what specific changes should the owner make to get a GO on the next tour? Be direct and actionable (pricing, cosmetic updates, appliances, cleaning, curb appeal, finishes).

PARAGRAPH 2 — COMPETITIVE MARKET ANALYSIS: Search Zillow, Apartments.com, and Realtor.com for rentals within 0.25 miles of "${propName}" in Oklahoma City, OK priced within 10% of this unit's market rent. What amenities or features are nearby competitors offering that this property lacks? Is a price adjustment warranted? What upgrades would close the gap fastest?

Write ONLY the two paragraphs. No headers, no bullets.`;

    const completion = await fetchGrokWithSearch(prompt);
    const text = completion || '';
    res.json({ recommendation: text.trim(), total: rows.length, go, nogo, maybe, topIssues });
  } catch(e) {
    console.error('property-ai-rec error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// AI property recommendation — feedback + live nearby listing search via Grok
app.post('/api/showings/property-recommendation', auth, async (req, res) => {
  try {
    const { propertyName, stats } = req.body;
    if (!propertyName) return res.status(400).json({ error: 'propertyName required' });

    const grok = initGrok();
    if (!grok) return res.status(503).json({ error: 'Grok API key not configured' });

    const { go=0, nogo=0, maybe=0, total=0, topIssues=[], recentNotes=[] } = stats || {};
    const issueList = topIssues.map(i => `  - ${i.cat}: mentioned ${i.count} time(s)`).join('\n') || '  - No issues tagged';
    const notesSample = recentNotes.filter(Boolean).slice(0, 6).map((n,i) => `  ${i+1}. "${n}"`).join('\n') || '  None recorded';

    const prompt = `You are a property management advisor for OKCREAL, a property management company in Oklahoma City, OK.

PROPERTY: "${propertyName}"
TOUR FEEDBACK SUMMARY:
- Total tours: ${total} | GO: ${go} | MAYBE: ${maybe} | NO-GO: ${nogo}
- Top objections from prospective renters:
${issueList}
- Sample agent notes from tours:
${notesSample}

YOUR TASK — write exactly TWO paragraphs separated by a blank line:

PARAGRAPH 1 — FEEDBACK ANALYSIS:
Based on the tour feedback above, write a direct actionable paragraph explaining what specific changes the property owner should make to convert future tours to a "GO" decision. Focus on what can actually be fixed: pricing, cosmetic updates, appliances, cleaning, curb appeal, finishes, etc.

PARAGRAPH 2 — COMPETITIVE MARKET ANALYSIS:
Search for current rental listings within 0.25 miles of "${propertyName}" in Oklahoma City, OK. Look on Zillow, Apartments.com, or Realtor.com. Find comparable rentals priced within 10% of this property's likely market rent. Compare their listed amenities, finishes, and features to the objections raised in the feedback. Then write a paragraph stating: which specific amenities or features nearby competitors are offering that this property may be lacking, whether a price adjustment is warranted, and what upgrades would make the biggest competitive difference.

Write ONLY the two paragraphs. No headers, no bullet points, no preamble.`;

    const text = await fetchGrokWithSearch(prompt);
    res.json({ recommendation: (text || '').trim() });

  } catch(e) {
    console.error('property-recommendation error:', e.message);
    res.status(500).json({ error: e.message });
  }
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
// ── Showings Dashboard — all data in one call ────────────────────────────────
app.get('/api/showings/dashboard', auth, async (req, res) => {
  try {
    const [upcomingR, inProgressR, recentR, pendingFbR, kpiR] = await Promise.all([
      // All scheduled showings from now through 14 days
      pool.query(`
        SELECT s.id, s.property, s.unit, s.guest_name, s.phone, s.email,
               s.showing_time, s.status, s.showing_type, s.assigned_user,
               s.connect_person_id, s.feedback_sent,
               f.verdict AS feedback_verdict, f.source AS feedback_source
        FROM showings s
        LEFT JOIN showing_feedback f ON f.showing_id = s.id
        WHERE s.status = 'Scheduled'
          AND s.showing_time > NOW() - INTERVAL '30 minutes'
          AND s.showing_time < NOW() + INTERVAL '14 days'
        ORDER BY s.showing_time ASC
      `),
      // Active/in-progress (within 30 min of now)
      pool.query(`
        SELECT s.id, s.property, s.unit, s.guest_name, s.phone,
               s.showing_time, s.showing_type, s.connect_person_id
        FROM showings s
        WHERE s.status = 'Scheduled'
          AND s.showing_time BETWEEN NOW() - INTERVAL '30 minutes' AND NOW() + INTERVAL '5 minutes'
        ORDER BY s.showing_time ASC
      `),
      // Completed in last 7 days needing feedback
      pool.query(`
        SELECT s.id, s.property, s.unit, s.guest_name, s.phone, s.email,
               s.showing_time, s.connect_person_id, s.feedback_sent,
               f.verdict, f.categories, f.notes, f.source AS feedback_source,
               f.agent_name, f.created_at AS feedback_at
        FROM showings s
        LEFT JOIN showing_feedback f ON f.showing_id = s.id
        WHERE s.showing_time < NOW()
          AND s.showing_time > NOW() - INTERVAL '14 days'
        ORDER BY s.showing_time DESC
      `),
      // Showings with no feedback at all (last 7 days)
      pool.query(`
        SELECT s.id, s.property, s.unit, s.guest_name, s.phone, s.email,
               s.showing_time, s.connect_person_id, s.feedback_sent
        FROM showings s
        LEFT JOIN showing_feedback f ON f.showing_id = s.id
        WHERE f.id IS NULL
          AND s.showing_time < NOW()
          AND s.showing_time > NOW() - INTERVAL '7 days'
        ORDER BY s.showing_time DESC
      `),
      // KPI stats
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE s.status = 'Scheduled' AND s.showing_time > NOW()) AS upcoming_total,
          COUNT(*) FILTER (WHERE s.showing_time::date = CURRENT_DATE AND s.status = 'Scheduled') AS today,
          COUNT(*) FILTER (WHERE s.showing_time > NOW() - INTERVAL '7 days' AND s.showing_time < NOW()) AS completed_week,
          COUNT(*) FILTER (WHERE s.showing_time < NOW() AND s.showing_time > NOW() - INTERVAL '7 days' AND NOT EXISTS(SELECT 1 FROM showing_feedback f2 WHERE f2.showing_id = s.id)) AS pending_feedback,
          (SELECT MIN(showing_time) FROM showings WHERE status = 'Scheduled' AND showing_time > NOW()) AS next_showing
        FROM showings s
      `)
    ]);

    res.json({
      upcoming: upcomingR.rows,
      inProgress: inProgressR.rows,
      recentWithFeedback: recentR.rows,
      pendingFeedback: pendingFbR.rows,
      kpi: kpiR.rows[0] || {},
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Send feedback link SMS to prospect ───────────────────────────────────────
app.post('/api/showings/:id/send-feedback-link', auth, async (req, res) => {
  try {
    const showing = await pool.query('SELECT * FROM showings WHERE id = $1', [req.params.id]);
    if (!showing.rows[0]) return res.status(404).json({ error: 'Showing not found' });
    const s = showing.rows[0];
    if (!s.phone) return res.status(400).json({ error: 'No phone number for this prospect' });

    const twilio = initTwilio();
    if (!twilio) return res.status(503).json({ error: 'Twilio not configured' });

    const feedbackUrl = `${process.env.APP_URL}/api/showings/${s.id}/public-feedback`;
    const propName = (s.property || '').split(' - ')[0];
    const firstName = (s.guest_name||'').replace(/,.*/, '').split(' ')[0] || 'there';
    const body = `Hi ${firstName}! Feedback matters a lot! Please leave feedback to help us and others for ${propName}. It only takes 30 seconds — click here: ${feedbackUrl}`;

    const fromNumber = process.env.TWILIO_RESIDENT_NUMBER || '+14052562614';
    await twilio.messages.create({ body, from: fromNumber, to: s.phone });
    await pool.query('UPDATE showings SET feedback_sent = true WHERE id = $1', [s.id]);

    // Log activity if person linked
    if (s.connect_person_id) {
      await pool.query(
        `INSERT INTO activities (person_id, agent_id, type, body, direction) VALUES ($1, $2, 'sms', $3, 'outbound')`,
        [s.connect_person_id, req.agent.id, body]
      ).catch(() => {});
    }

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
// WORK ORDER ALERTS — Performance, Alerts, Person-level, Cross-reference
// These are at the top level (not inside async chain) so they always register
// =============================================================================
const WO_OVERDUE_HOURS = 6;
const WO_OPEN = ['New','Estimate Requested','Estimated','Assigned','Scheduled','Waiting','Work Done','Ready to Bill'];
const WO_CLOSED = ['Completed','Completed No Need To Bill','Canceled','Cancelled'];

function classifyWOAlert(wo) {
  if (WO_CLOSED.includes(wo.status)) return 'COMPLETED';
  if (!WO_OPEN.includes(wo.status)) return 'COMPLETED';
  if (!wo.scheduled_end) return 'NOT_SCHEDULED';
  const se = new Date(wo.scheduled_end);
  if (isNaN(se.getTime())) return 'NOT_SCHEDULED';
  if ((Date.now() - se.getTime()) / 3600000 >= WO_OVERDUE_HOURS) return 'OVERDUE';
  return 'ON_TRACK';
}

// ── Performance dashboard ────────────────────────────────────────────────────
app.get('/api/work-orders/performance', auth, async (req, res) => {
  try {
    const kpi = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status NOT IN ('Completed','Completed No Need To Bill','Canceled','Cancelled'))::int AS open,
        COUNT(*) FILTER (WHERE status IN ('Completed','Completed No Need To Bill'))::int AS completed,
        COUNT(*) FILTER (WHERE status = 'Canceled' OR status = 'Cancelled')::int AS canceled,
        ROUND(AVG(
          CASE WHEN completed_on IS NOT NULL AND created_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (completed_on - created_at)) / 86400.0 END
        )::numeric, 1) AS avg_days_to_close
      FROM work_orders
    `);

    // Alert breakdown (real-time)
    const alertsR = await pool.query(`
      SELECT status, scheduled_end, created_at FROM work_orders
      WHERE status NOT IN ('Completed','Completed No Need To Bill','Canceled','Cancelled')
    `);
    let overdue = 0, notScheduled = 0, onTrack = 0;
    for (const wo of alertsR.rows) {
      const a = classifyWOAlert(wo);
      if (a === 'OVERDUE') overdue++;
      else if (a === 'NOT_SCHEDULED') notScheduled++;
      else if (a === 'ON_TRACK') onTrack++;
    }

    // Vendor ranking
    const vendors = await pool.query(`
      SELECT vendor,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status IN ('Completed','Completed No Need To Bill'))::int AS completed,
        COUNT(*) FILTER (WHERE status NOT IN ('Completed','Completed No Need To Bill','Canceled','Cancelled'))::int AS open,
        ROUND(AVG(
          CASE WHEN completed_on IS NOT NULL AND created_at IS NOT NULL
          THEN EXTRACT(EPOCH FROM (completed_on - created_at)) / 86400.0 END
        )::numeric, 1) AS avg_days_to_close,
        ROUND(SUM(COALESCE(amount,0))::numeric, 2) AS total_cost
      FROM work_orders WHERE vendor IS NOT NULL AND vendor != ''
      GROUP BY vendor ORDER BY COUNT(*) DESC
    `);

    // Property volume
    const propVolume = await pool.query(`
      WITH monthly AS (
        SELECT property, DATE_TRUNC('month', created_at) AS month, COUNT(*)::int AS cnt
        FROM work_orders WHERE created_at > NOW() - INTERVAL '6 months'
        GROUP BY property, DATE_TRUNC('month', created_at)
      )
      SELECT property,
        COALESCE(MAX(CASE WHEN month = DATE_TRUNC('month', NOW()) THEN cnt END), 0)::int AS this_month,
        ROUND(AVG(CASE WHEN month < DATE_TRUNC('month', NOW()) THEN cnt END)::numeric, 1) AS rolling_avg,
        CASE WHEN AVG(CASE WHEN month < DATE_TRUNC('month', NOW()) THEN cnt END) > 0
          THEN ROUND((COALESCE(MAX(CASE WHEN month = DATE_TRUNC('month', NOW()) THEN cnt END), 0)
            / AVG(CASE WHEN month < DATE_TRUNC('month', NOW()) THEN cnt END) - 1) * 100)::int
          ELSE 0 END AS delta_pct,
        COALESCE(MAX(CASE WHEN month = DATE_TRUNC('month', NOW()) THEN cnt END), 0)
          > COALESCE(AVG(CASE WHEN month < DATE_TRUNC('month', NOW()) THEN cnt END), 999) AS exceeds_avg
      FROM monthly GROUP BY property
      HAVING COALESCE(MAX(CASE WHEN month = DATE_TRUNC('month', NOW()) THEN cnt END), 0)
        + COALESCE(MAX(CASE WHEN month = DATE_TRUNC('month', NOW() - INTERVAL '1 month') THEN cnt END), 0) > 0
      ORDER BY COALESCE(MAX(CASE WHEN month = DATE_TRUNC('month', NOW()) THEN cnt END), 0) DESC LIMIT 20
    `);

    // Issue breakdown
    const issues = await pool.query(`
      SELECT COALESCE(issue, 'Unspecified') AS issue, COUNT(*)::int AS cnt
      FROM work_orders WHERE issue IS NOT NULL AND issue != ''
      GROUP BY issue ORDER BY COUNT(*) DESC LIMIT 15
    `);

    res.json({
      kpi: kpi.rows[0],
      alerts: { overdue, notScheduled, onTrack },
      vendors: vendors.rows,
      propertyVolume: propVolume.rows,
      issueBreakdown: issues.rows,
    });
  } catch(e) { console.error('[WO Perf]', e.message); res.status(500).json({ error: e.message }); }
});

// ── All open alerts ──────────────────────────────────────────────────────────
app.get('/api/work-orders/alerts', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT wo_number, property, unit, resident, status, vendor, issue,
             priority, scheduled_start, scheduled_end, created_at,
             person_id, is_household, matched_tenants
      FROM work_orders
      WHERE status NOT IN ('Completed','Completed No Need To Bill','Canceled','Cancelled')
      ORDER BY created_at ASC
    `);
    const alerts = rows.map(wo => ({
      ...wo,
      alert_state: classifyWOAlert(wo),
      days_open: wo.created_at ? Math.round(((Date.now() - new Date(wo.created_at).getTime()) / 86400000) * 10) / 10 : null,
    }));
    const overdue = alerts.filter(a => a.alert_state === 'OVERDUE').length;
    const notScheduled = alerts.filter(a => a.alert_state === 'NOT_SCHEDULED').length;
    const onTrack = alerts.filter(a => a.alert_state === 'ON_TRACK').length;
    res.json({ alerts, summary: { total: alerts.length, overdue, notScheduled, onTrack } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Person-level work orders (for leads page) ───────────────────────────────
app.get('/api/work-orders/by-person/:personId', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT wo_number, property, unit, resident, status, vendor, issue,
              priority, alert_state, scheduled_start, scheduled_end, created_at,
              days_open, job_description, is_household, matched_tenants
       FROM work_orders WHERE person_id = $1
       ORDER BY CASE WHEN status IN ('Completed','Completed No Need To Bill','Canceled','Cancelled') THEN 1 ELSE 0 END, created_at DESC`,
      [req.params.personId]
    );
    // Also get household WOs
    const { rows: hhRows } = await pool.query(
      `SELECT DISTINCT wo.wo_number, wo.property, wo.unit, wo.resident, wo.status,
              wo.vendor, wo.issue, wo.priority, wo.alert_state, wo.scheduled_start,
              wo.scheduled_end, wo.created_at, wo.days_open, wo.job_description,
              wo.is_household, wo.matched_tenants
       FROM work_orders wo
       JOIN person_relationships pr ON (
         (pr.person_id_a = $1 AND wo.person_id = pr.person_id_b)
         OR (pr.person_id_b = $1 AND wo.person_id = pr.person_id_a)
       )
       WHERE pr.label = 'household'
         AND wo.status NOT IN ('Completed','Completed No Need To Bill','Canceled','Cancelled')
         AND wo.wo_number NOT IN (SELECT wo_number FROM work_orders WHERE person_id = $1)`,
      [req.params.personId]
    );

    const allWOs = [...rows, ...hhRows].map(wo => ({
      ...wo, alert_state: classifyWOAlert(wo),
    }));
    const open = allWOs.filter(w => w.alert_state !== 'COMPLETED');
    res.json({
      workOrders: allWOs, open: open.length,
      overdue: open.filter(w => w.alert_state === 'OVERDUE').length,
      notScheduled: open.filter(w => w.alert_state === 'NOT_SCHEDULED').length,
      onTrack: open.filter(w => w.alert_state === 'ON_TRACK').length,
      hasHouseholdWOs: hhRows.length > 0,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Enhanced upload with cross-reference + alerts ────────────────────────────
app.post('/api/work-orders/upload-v2', auth, async (req, res) => {
  try {
    const { rows, filename } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'No rows provided' });
    const batchId = crypto.randomUUID();
    let inserted = 0, skipped = 0, matched = 0, households = 0;

    for (const r of rows) {
      if (!r.wo_number && !r.job_description) { skipped++; continue; }
      const woObj = { status: r.status||'', scheduled_end: r.scheduled_end ? new Date(r.scheduled_end) : null };
      const alertState = classifyWOAlert(woObj);
      const createdDate = r.created_at ? new Date(r.created_at) : null;
      const daysOpen = createdDate && !isNaN(createdDate.getTime())
        ? Math.round(((Date.now() - createdDate.getTime()) / 86400000) * 10) / 10 : null;

      // Cross-reference rent roll
      let personId = null, matchedTenants = [], isHousehold = false;
      try {
        const prop = r.property || '';
        const unitRaw = r.unit || null;
        let rrRows;
        if (unitRaw) {
          const normUnit = unitRaw.replace(/^(Unit|APT|Apt|#|Villa Chateau Apartments:\s*Unit)\s*/i, '').trim().toLowerCase();
          const { rows: rr } = await pool.query(
            `SELECT id, tenant_name, person_id FROM rent_roll
             WHERE property = $1 AND status = 'Current'
             AND LOWER(TRIM(REGEXP_REPLACE(unit, '^(Unit|APT|Apt|#)\\s*', '', 'i'))) = $2`,
            [prop, normUnit]);
          rrRows = rr;
        } else {
          const { rows: rr } = await pool.query(
            `SELECT id, tenant_name, person_id FROM rent_roll
             WHERE property = $1 AND status = 'Current'`, [prop]);
          if (rr.length === 1) rrRows = rr; else rrRows = [];
        }
        matchedTenants = rrRows.map(t => t.tenant_name);
        isHousehold = rrRows.length > 1;
        if (rrRows.length) {
          personId = rrRows[0].person_id;
          // Try name match for primary
          if (r.resident) {
            const resNorm = (r.resident||'').replace(/[^a-z]/gi,'').toLowerCase();
            for (const t of rrRows) {
              const tNorm = (t.tenant_name||'').replace(/[^a-z]/gi,'').toLowerCase();
              const parts = (r.resident||'').split(',').map(s=>s.trim());
              const rev = parts.length===2 ? (parts[1]+parts[0]).replace(/[^a-z]/gi,'').toLowerCase() : '';
              if (tNorm === resNorm || tNorm === rev) { personId = t.person_id; break; }
            }
          }
          if (personId) matched++;
          if (isHousehold) households++;
        }
      } catch(xrefErr) { /* non-fatal */ }

      try {
        await pool.query(
          `INSERT INTO work_orders
             (property, wo_number, priority, wo_type, job_description, instructions,
              status, vendor, unit, resident, created_at, scheduled_start, scheduled_end,
              work_done_on, completed_on, amount, issue, recurring, upload_batch,
              alert_state, person_id, matched_tenants, is_household, days_open)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
           ON CONFLICT (wo_number) DO UPDATE SET
             status=EXCLUDED.status, vendor=EXCLUDED.vendor,
             scheduled_start=EXCLUDED.scheduled_start, scheduled_end=EXCLUDED.scheduled_end,
             work_done_on=EXCLUDED.work_done_on, completed_on=EXCLUDED.completed_on,
             amount=EXCLUDED.amount, issue=EXCLUDED.issue, instructions=EXCLUDED.instructions,
             upload_batch=EXCLUDED.upload_batch, alert_state=EXCLUDED.alert_state,
             person_id=COALESCE(EXCLUDED.person_id, work_orders.person_id),
             matched_tenants=EXCLUDED.matched_tenants, is_household=EXCLUDED.is_household,
             days_open=EXCLUDED.days_open`,
          [ r.property||null, r.wo_number||null, r.priority||null, r.wo_type||null,
            r.job_description||null, r.instructions||null, r.status||null,
            r.vendor||null, r.unit||null, r.resident||null,
            r.created_at ? new Date(r.created_at) : null,
            r.scheduled_start ? new Date(r.scheduled_start) : null,
            r.scheduled_end ? new Date(r.scheduled_end) : null,
            r.work_done_on ? new Date(r.work_done_on) : null,
            r.completed_on ? new Date(r.completed_on) : null,
            r.amount ? parseFloat(r.amount) : null,
            r.issue||null, r.recurring||null, batchId,
            alertState, personId, matchedTenants.length ? matchedTenants : null,
            isHousehold, daysOpen ]
        );
        inserted++;
      } catch(e) { console.warn('[WO Upload v2] skip:', e.message); skipped++; }
    }

    const uploader = req.agent?.name || req.agent?.id || null;
    await pool.query(`INSERT INTO work_order_uploads (filename,uploaded_by,record_count) VALUES ($1,$2,$3)`,
      [filename||'work_orders.xlsx', uploader, inserted]);
    broadcastToAll({ type: 'work_orders_updated', inserted, matched });
    res.json({ ok: true, inserted, skipped, matched, households, batchId });
  } catch(e) { console.error('[WO Upload v2]', e.message); res.status(500).json({ error: e.message }); }
});

// ── Auto-link rent roll to people + household grouping ───────────────────────
app.post('/api/work-orders/auto-link', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, tenant_name FROM rent_roll WHERE person_id IS NULL AND status = 'Current'`);
    let linked = 0;
    for (const rr of rows) {
      const parts = (rr.tenant_name||'').trim().split(/\s+/);
      if (parts.length < 2) continue;
      const first = parts[0], last = parts[parts.length-1];
      const { rows: ppl } = await pool.query(
        `SELECT id FROM people WHERE LOWER(TRIM(first_name))=LOWER($1) AND LOWER(TRIM(last_name))=LOWER($2) LIMIT 1`,
        [first, last]);
      if (ppl[0]) {
        await pool.query('UPDATE rent_roll SET person_id=$1 WHERE id=$2', [ppl[0].id, rr.id]);
        linked++;
      }
    }
    // Update work_orders person_id from newly linked rent_roll
    await pool.query(`
      UPDATE work_orders wo SET person_id = rr.person_id
      FROM rent_roll rr
      WHERE wo.person_id IS NULL AND rr.person_id IS NOT NULL AND rr.property = wo.property AND rr.status = 'Current'
        AND (wo.unit IS NOT NULL AND LOWER(TRIM(rr.unit)) = LOWER(TRIM(wo.unit))
          OR (wo.unit IS NULL AND (rr.unit IS NULL OR rr.unit = '')))`).catch(()=>{});
    // Auto-group households
    const { rows: hhGroups } = await pool.query(`
      SELECT property, unit, ARRAY_AGG(person_id) AS person_ids FROM rent_roll
      WHERE person_id IS NOT NULL AND status='Current' GROUP BY property, unit HAVING COUNT(DISTINCT person_id)>1`);
    let hhCreated = 0;
    for (const g of hhGroups) {
      const ids = g.person_ids.filter(Boolean);
      for (let i=0; i<ids.length; i++) for (let j=i+1; j<ids.length; j++) {
        const a=Math.min(ids[i],ids[j]), b=Math.max(ids[i],ids[j]);
        await pool.query(`INSERT INTO person_relationships(person_id_a,person_id_b,label) VALUES($1,$2,'household') ON CONFLICT DO NOTHING`,[a,b]).catch(()=>{});
        hhCreated++;
      }
    }
    res.json({ ok:true, linked, households: { units: hhGroups.length, relationships: hhCreated } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Reclassify all open WO alerts ────────────────────────────────────────────
app.post('/api/work-orders/reclassify', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, status, scheduled_end, created_at FROM work_orders
       WHERE status NOT IN ('Completed','Completed No Need To Bill','Canceled','Cancelled')`);
    let overdue=0, notSched=0, onTrack=0;
    for (const wo of rows) {
      const alert = classifyWOAlert(wo);
      const daysOpen = wo.created_at ? Math.round(((Date.now()-new Date(wo.created_at).getTime())/86400000)*10)/10 : null;
      await pool.query('UPDATE work_orders SET alert_state=$1, days_open=$2 WHERE id=$3', [alert, daysOpen, wo.id]);
      if (alert==='OVERDUE') overdue++; else if (alert==='NOT_SCHEDULED') notSched++; else if (alert==='ON_TRACK') onTrack++;
    }
    await pool.query(`UPDATE work_orders SET alert_state='COMPLETED' WHERE status IN ('Completed','Completed No Need To Bill','Canceled','Cancelled') AND alert_state!='COMPLETED'`);
    res.json({ ok:true, overdue, notScheduled: notSched, onTrack });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
// JIREH TOGGLE WIDGET — drop-in script for public/index.html
// Usage: <script src="/jireh-toggle.js"></script>  ← add once to <head>
// Automatically injects a toggle bar at the top of the app (above all content).
// Reads/writes the jireh_inbound_enabled setting via /api/jareih/settings.
// =============================================================================
app.get('/jireh-toggle.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(`
(function () {
  'use strict';

  // ── Auth ─────────────────────────────────────────────────────────────────
  function getToken() {
    return localStorage.getItem('token') || localStorage.getItem('connect_token') || '';
  }

  // ── API ──────────────────────────────────────────────────────────────────
  async function fetchSetting() {
    try {
      const r = await fetch('/api/jareih/settings', {
        headers: { Authorization: 'Bearer ' + getToken() }
      });
      if (!r.ok) return null;
      const d = await r.json();
      return d.jireh_inbound_enabled === 'true';
    } catch(e) { return null; }
  }

  async function saveSetting(enabled) {
    try {
      await fetch('/api/jareih/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
        body: JSON.stringify({ jireh_inbound_enabled: String(enabled) })
      });
    } catch(e) { console.warn('[Jireh toggle] save failed', e); }
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  // Uses ONLY CSS variables from the app theme — works in both stealth & daylight.
  // No hardcoded colors so the bar inherits whatever theme is active on <html>.
  function injectStyles() {
    if (document.getElementById('jireh-toggle-styles')) return;
    const s = document.createElement('style');
    s.id = 'jireh-toggle-styles';
    s.textContent = \`
      /* ── Jireh toggle bar ───────────────────────────────────────────────
         Sits inside #app, above .app-body — does NOT affect 100vh layout.
         All colors come from the active theme's CSS variables.
      ─────────────────────────────────────────────────────────────────── */
      #jireh-toggle-bar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 16px;
        height: 36px;
        min-height: 36px;
        flex-shrink: 0;
        background: var(--bg-2);
        border-bottom: 1px solid var(--border);
        font-family: var(--font-body, sans-serif);
        position: relative;
        z-index: 200;
        user-select: none;
        box-sizing: border-box;
      }

      /* Icon */
      #jireh-toggle-bar .jtb-icon {
        width: 14px;
        height: 14px;
        flex-shrink: 0;
        color: var(--red);
        opacity: 0.85;
      }

      /* Label */
      #jireh-toggle-bar .jtb-label {
        font-family: var(--font-cond, sans-serif);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--text-2);
        flex-shrink: 0;
      }

      /* Toggle pill */
      .jtb-switch {
        position: relative;
        display: inline-flex;
        align-items: center;
        width: 40px;
        height: 22px;
        flex-shrink: 0;
        cursor: pointer;
      }
      .jtb-switch input {
        opacity: 0;
        width: 0;
        height: 0;
        position: absolute;
        pointer-events: none;
      }
      .jtb-slider {
        position: absolute;
        inset: 0;
        background: var(--bg-4);
        border: 1px solid var(--border);
        border-radius: 22px;
        transition: background 0.18s, border-color 0.18s;
      }
      .jtb-slider::before {
        content: '';
        position: absolute;
        width: 16px;
        height: 16px;
        left: 2px;
        top: 2px;
        background: var(--text-3);
        border-radius: 50%;
        transition: transform 0.18s, background 0.18s;
      }
      .jtb-switch input:checked + .jtb-slider {
        background: color-mix(in srgb, var(--red) 15%, var(--bg-2));
        border-color: var(--red);
      }
      .jtb-switch input:checked + .jtb-slider::before {
        transform: translateX(18px);
        background: var(--red);
      }

      /* Status text */
      #jireh-toggle-status {
        font-family: var(--font-cond, sans-serif);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        color: var(--text-3);
        transition: color 0.18s;
        min-width: 24px;
      }
      #jireh-toggle-status.jtb-on {
        color: var(--red);
      }

      /* Right-side hint */
      #jireh-toggle-bar .jtb-hint {
        margin-left: auto;
        font-family: var(--font-cond, sans-serif);
        font-size: 10px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--text-3);
        opacity: 0.55;
        flex-shrink: 0;
      }
    \`;
    document.head.appendChild(s);
  }

  // ── HTML ─────────────────────────────────────────────────────────────────
  function buildBar() {
    const bar = document.createElement('div');
    bar.id = 'jireh-toggle-bar';
    bar.innerHTML = \`
      <svg class="jtb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.07 12 19.79 19.79 0 0 1 1 3.18 2 2 0 0 1 2.99 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.09 8.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21 16z"/>
      </svg>
      <span class="jtb-label">Jireh</span>
      <label class="jtb-switch" title="Jireh answers after 4 rings when ON">
        <input type="checkbox" id="jireh-toggle-input">
        <span class="jtb-slider"></span>
      </label>
      <span id="jireh-toggle-status">–</span>
      <span class="jtb-hint">Answers after 4 rings when ON</span>
    \`;
    return bar;
  }

  // ── State ─────────────────────────────────────────────────────────────────
  function applyState(enabled) {
    const input = document.getElementById('jireh-toggle-input');
    const status = document.getElementById('jireh-toggle-status');
    if (!input || !status) return;
    input.checked = !!enabled;
    if (enabled === null) {
      status.textContent = '–';
      status.className = '';
    } else {
      status.textContent = enabled ? 'ON' : 'OFF';
      status.className = enabled ? 'jtb-on' : '';
    }
  }

  // ── Mount ─────────────────────────────────────────────────────────────────
  // Injects the bar INSIDE #app, ABOVE .app-body.
  // This preserves the 100vh flex-column layout and respects sidebar width.
  // Falls back to body prepend only if #app never appears (login screen etc.)
  function tryMount() {
    if (document.getElementById('jireh-toggle-bar')) return true;

    // Target: #app element (the main app shell, flex column, 100vh)
    const appEl = document.getElementById('app');
    if (!appEl) return false; // not ready yet

    injectStyles();
    const bar = buildBar();

    // Insert as first child of #app, before .app-body
    appEl.insertBefore(bar, appEl.firstChild);

    const input = document.getElementById('jireh-toggle-input');
    if (input) {
      input.addEventListener('change', async () => {
        const enabled = input.checked;
        applyState(enabled);
        await saveSetting(enabled);
      });
    }

    // Load current state from DB
    fetchSetting().then(applyState);
    return true;
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  // Poll until #app exists (SPA may render it after DOMContentLoaded)
  let mountInterval = null;

  function startPolling() {
    if (mountInterval) return;
    mountInterval = setInterval(() => {
      if (tryMount()) {
        clearInterval(mountInterval);
        mountInterval = null;
      }
    }, 80);
    // Give up after 10s to avoid running forever on login screen
    setTimeout(() => {
      if (mountInterval) { clearInterval(mountInterval); mountInterval = null; }
    }, 10000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPolling);
  } else {
    startPolling();
  }

  // Re-mount after SPA navigation (pushState / popstate)
  const _pushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    _pushState(...args);
    setTimeout(() => { if (!document.getElementById('jireh-toggle-bar')) startPolling(); }, 60);
  };
  window.addEventListener('popstate', () => {
    setTimeout(() => { if (!document.getElementById('jireh-toggle-bar')) startPolling(); }, 60);
  });

  // Re-mount if #app becomes visible (login → dashboard transition)
  const _observer = new MutationObserver(() => {
    if (!document.getElementById('jireh-toggle-bar')) tryMount();
  });
  _observer.observe(document.body || document.documentElement, { childList: true, subtree: false, attributes: true, attributeFilter: ['class', 'style'] });

})();
`);
});

// =============================================================================
// WEATHER CONTROL CENTER — NWS Alerts + Property Impact
// =============================================================================

let _weatherCache = { alerts: [], conditions: null, lastFetch: 0 };
const WEATHER_COUNTIES = ['Oklahoma','Cleveland','Pottawatomie','Canadian','Logan'];
const WEATHER_CENTER = { lat: 35.4676, lon: -97.5164 }; // OKC
const SEVERE_TYPES = ['Tornado Warning','Tornado Watch','Severe Thunderstorm Warning','Severe Thunderstorm Watch','Flash Flood Warning','Winter Storm Warning','Ice Storm Warning','Blizzard Warning','Wind Advisory','High Wind Warning','Freeze Warning','Hard Freeze Warning','Wind Chill Warning','Extreme Cold Warning'];

async function fetchNWSAlerts() {
  try {
    const resp = await fetch('https://api.weather.gov/alerts/active?area=OK', {
      headers: { 'User-Agent': '(OKCREAL Connect, admin@okcreal.com)', 'Accept': 'application/geo+json' },
      signal: AbortSignal.timeout(4000)
    });
    if (!resp.ok) { console.warn('[Weather] NWS API:', resp.status); return []; }
    const data = await resp.json();
    const features = data.features || [];
    // Filter to our counties + severe types
    return features.filter(f => {
      const props = f.properties || {};
      const zones = (props.areaDesc || '').toLowerCase();
      const isOurArea = WEATHER_COUNTIES.some(c => zones.includes(c.toLowerCase()));
      return isOurArea;
    }).map(f => {
      const p = f.properties;
      return {
        id: p.id,
        event: p.event,
        severity: p.severity,
        certainty: p.certainty,
        urgency: p.urgency,
        headline: p.headline,
        description: (p.description || '').substring(0, 600),
        instruction: (p.instruction || '').substring(0, 400),
        areaDesc: p.areaDesc,
        effective: p.effective,
        expires: p.expires,
        sender: p.senderName,
        isSevere: SEVERE_TYPES.includes(p.event),
        isDamaging: ['Tornado Warning','Severe Thunderstorm Warning','Flash Flood Warning','Winter Storm Warning','Ice Storm Warning','Blizzard Warning'].includes(p.event),
      };
    });
  } catch(e) { console.warn('[Weather] Fetch error:', e.message); return []; }
}

async function fetchNWSConditions() {
  // Try multiple OKC-area stations for best data availability
  const stations = ['KOKC', 'KPWA', 'KOUN'];
  for (const station of stations) {
    try {
      const resp = await fetch(`https://api.weather.gov/stations/${station}/observations/latest`, {
        headers: { 'User-Agent': '(OKCREAL Connect, admin@okcreal.com)' },
        signal: AbortSignal.timeout(3000)
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const p = data.properties || {};
      const temp = p.temperature?.value;
      if (temp == null) continue; // Skip station if no temp data
      return {
        temperature: Math.round(temp * 9/5 + 32),
        windSpeed: p.windSpeed?.value != null ? Math.round(p.windSpeed.value * 0.621371) : null,
        windGust: p.windGust?.value != null ? Math.round(p.windGust.value * 0.621371) : null,
        windDirection: p.windDirection?.value,
        humidity: p.relativeHumidity?.value != null ? Math.round(p.relativeHumidity.value) : null,
        description: p.textDescription,
        timestamp: p.timestamp,
        station,
      };
    } catch(e) { continue; }
  }
  return null;
}

async function refreshWeatherCache() {
  const now = Date.now();
  const hasData = _weatherCache.conditions && _weatherCache.conditions.temperature != null;
  if (hasData && now - _weatherCache.lastFetch < 120000) return;
  _weatherCache.lastFetch = now;
  try {
    const [alerts, conditions] = await Promise.all([fetchNWSAlerts(), fetchNWSConditions()]);
    const prevSevere = _weatherCache.alerts.filter(a => a.isSevere).length;
    if (alerts) _weatherCache.alerts = alerts;
    if (conditions) _weatherCache.conditions = conditions;

    // Broadcast if new severe alerts appeared
    const nowSevere = (alerts||[]).filter(a => a.isSevere).length;
    if (nowSevere > 0 && nowSevere !== prevSevere) {
      console.log(`[Weather] ⚠ ${nowSevere} severe alert(s) — broadcasting to all agents`);
      broadcastToAll({ type: 'weather_alert', alerts: (alerts||[]).filter(a => a.isSevere) });
    }
    if (nowSevere === 0 && prevSevere > 0) {
      console.log('[Weather] ✓ All clear — no severe alerts');
      broadcastToAll({ type: 'weather_clear' });
    }
  } catch(e) { console.warn('[Weather] refresh error:', e.message); }
}

app.get('/api/weather/dashboard', auth, async (req, res) => {
  try {
    // Non-blocking: kick off refresh in background, return cached data immediately
    refreshWeatherCache().catch(() => {});

    // Get ALL properties from rent roll + showings combined
    const propsR = await pool.query(`
      SELECT combined.property,
             COALESCE(rr.units, 0)::int AS units,
             COALESCE(rr.tenants, 0)::int AS tenants
      FROM (
        SELECT DISTINCT property FROM rent_roll
        UNION
        SELECT DISTINCT property FROM showings
      ) combined
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT unit)::int AS units,
               COUNT(DISTINCT CASE WHEN status='Current' THEN tenant_name END)::int AS tenants
        FROM rent_roll WHERE rent_roll.property = combined.property
      ) rr ON TRUE
      ORDER BY combined.property
    `);

    const properties = propsR.rows.map(r => {
      const name = (r.property || '').split(' - ')[0];
      const addrMatch = (r.property || '').match(/ - (.+)/);
      const address = addrMatch ? addrMatch[1].trim() : '';
      return { name, fullName: r.property, address, units: r.units, tenants: r.tenants, affected: false };
    });

    // Mark properties as affected based on alert severity
    const damagingAlerts = _weatherCache.alerts.filter(a => a.isDamaging);
    const severeAlerts = _weatherCache.alerts.filter(a => a.isSevere && !a.isDamaging);
    if (damagingAlerts.length) {
      properties.forEach(p => { p.affected = 'danger'; });
    } else if (severeAlerts.length) {
      properties.forEach(p => { p.affected = 'warning'; });
    }

    res.json({
      alerts: _weatherCache.alerts,
      conditions: _weatherCache.conditions,
      properties,
      severeCount: _weatherCache.alerts.filter(a => a.isSevere).length,
      damagingCount: damagingAlerts.length,
      center: WEATHER_CENTER,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Property geocoding cache ─────────────────────────────────────────────
const _geocodeCache = new Map();

async function geocodeAddress(address) {
  if (!address) return null;
  const cacheKey = address.toLowerCase().trim();
  if (_geocodeCache.has(cacheKey)) return _geocodeCache.get(cacheKey);
  try {
    const resp = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1&countrycodes=us`, {
      headers: { 'User-Agent': 'OKCREAL-Connect/1.0 (admin@okcreal.com)' },
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) return null;
    const results = await resp.json();
    if (results.length) {
      const loc = { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
      _geocodeCache.set(cacheKey, loc);
      return loc;
    }
  } catch(e) { console.warn('[Geocode]', address.substring(0,30), e.message); }
  return null;
}

app.get('/api/weather/property-map', auth, async (req, res) => {
  try {
    refreshWeatherCache().catch(() => {});

    const propsR = await pool.query(`
      SELECT combined.property,
             COALESCE(rr.units, 0)::int AS units,
             COALESCE(rr.tenants, 0)::int AS tenants,
             gc.lat, gc.lon
      FROM (
        SELECT DISTINCT property FROM rent_roll
        UNION
        SELECT DISTINCT property FROM showings
      ) combined
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT unit)::int AS units,
               COUNT(DISTINCT CASE WHEN status='Current' THEN tenant_name END)::int AS tenants
        FROM rent_roll WHERE rent_roll.property = combined.property
      ) rr ON TRUE
      LEFT JOIN geocode_cache gc ON gc.address = combined.property
      ORDER BY combined.property
    `);

    const damagingAlerts = _weatherCache.alerts.filter(a => a.isDamaging);
    const severeAlerts = _weatherCache.alerts.filter(a => a.isSevere && !a.isDamaging);

    const properties = propsR.rows.map(r => {
      const name = (r.property || '').split(' - ')[0].trim();
      const addrMatch = (r.property || '').match(/ - (.+)/);
      // If has separator, use the part after it. Otherwise try the full name (may contain address)
      let address = addrMatch ? addrMatch[1].trim() : '';
      if (!address) {
        // Try using the full property name stripped of parenthetical labels
        address = (r.property || '').replace(/\([^)]*\)/g, '').replace(/DUPLEX|FOURPLEX|TRIPLEX/gi, '').trim();
      }
      // Clean address for geocoding: strip property names from front, keep street+city+state+zip
      address = address.replace(/^(Unit|Apt|Suite|#)\s*\S+\s*/i, '').trim();
      let status = 'clear';
      if (damagingAlerts.length) status = 'danger';
      else if (severeAlerts.length) status = 'warning';
      return {
        name, fullName: r.property, address, units: r.units, tenants: r.tenants, status,
        lat: r.lat ? parseFloat(r.lat) : null,
        lon: r.lon ? parseFloat(r.lon) : null,
      };
    });

    res.json({
      properties,
      alerts: _weatherCache.alerts,
      conditions: _weatherCache.conditions,
      center: WEATHER_CENTER,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Save geocoded coordinates for a property
app.post('/api/weather/geocode-save', auth, async (req, res) => {
  try {
    const { entries } = req.body; // [{ address, lat, lon }]
    if (!entries || !Array.isArray(entries)) return res.status(400).json({ error: 'entries required' });
    for (const e of entries) {
      if (!e.address || !e.lat || !e.lon) continue;
      await pool.query(
        `INSERT INTO geocode_cache (address, lat, lon, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (address) DO UPDATE SET lat=EXCLUDED.lat, lon=EXCLUDED.lon, updated_at=NOW()`,
        [e.address, e.lat, e.lon]
      );
    }
    res.json({ ok: true, saved: entries.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/weather/alerts', auth, async (req, res) => {
  refreshWeatherCache().catch(() => {});
  res.json(_weatherCache.alerts);
});

app.get('/api/weather/report', auth, async (req, res) => {
  try {
    refreshWeatherCache().catch(() => {});
    const propsR = await pool.query(`
      SELECT combined.property,
             COALESCE(rr.units, 0)::int AS units,
             COALESCE(rr.tenants, 0)::int AS tenants
      FROM (
        SELECT DISTINCT property FROM rent_roll
        UNION
        SELECT DISTINCT property FROM showings
      ) combined
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT unit)::int AS units,
               COUNT(DISTINCT CASE WHEN status='Current' THEN tenant_name END)::int AS tenants
        FROM rent_roll WHERE rent_roll.property = combined.property
      ) rr ON TRUE
      ORDER BY combined.property
    `);
    const damagingAlerts = _weatherCache.alerts.filter(a => a.isDamaging);
    const report = {
      generated: new Date().toISOString(),
      generatedBy: req.agent?.name || 'System',
      alerts: damagingAlerts,
      conditions: _weatherCache.conditions,
      properties: propsR.rows.map(r => ({
        name: (r.property || '').split(' - ')[0],
        fullName: r.property,
        units: r.units,
        tenants: r.tenants,
        affected: damagingAlerts.length > 0,
      })),
      totalUnits: propsR.rows.reduce((s,r) => s + r.units, 0),
      totalTenants: propsR.rows.reduce((s,r) => s + r.tenants, 0),
    };
    res.json(report);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// =============================================================================
// SPA CATCH-ALL — must be AFTER all API routes
// Serves index.html for every frontend path: /dashboard, /showings, /inbox, etc.
// =============================================================================
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
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

// =============================================================================
// JAREIH AI OUTBOUND CALL SYSTEM
// Stack: Twilio Media Streams → Deepgram STT → Grok 3 → Deepgram Aura TTS (Ara)
// =============================================================================

// =============================================================================
// JAREIH AI CALL CONTROL CENTER  v2
// Architecture: Twilio Conference → all parties in one room
//   • Contact leg  → Conference jcall-{callId}
//   • AI bridge    → Conference jcall-{callId} + Media Stream (Deepgram + Grok/Ara)
//   • Monitor agent→ Conference jcall-{callId} muted=true (listen only)
//   • Active agent → Conference jcall-{callId} muted=false (take over)
// =============================================================================

const jareihCalls = new Map();    // callId → session
const ttsAudioCache = new Map(); // token → Buffer (short-lived TTS audio)

// ─── helpers ─────────────────────────────────────────────────────────────────
function jcConferenceName(callId) { return `jcall-${callId}`; }

// ─── TTS: Deepgram Aura Ara ───────────────────────────────────────────────────
async function araTTS(text) {
  // xAI Ara voice — the real Ara from the Grok app
  const resp = await fetch('https://api.x.ai/v1/tts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text,
      voice_id: 'ara',
      language: 'en',
      output_format: { codec: 'mulaw', sample_rate: 8000, container: 'none' }
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`xAI TTS ${resp.status}: ${errText}`);
  }
  let audio = Buffer.from(await resp.arrayBuffer());
  console.log(`[Ara TTS] raw bytes=${audio.length} first4=${audio.slice(0,4).toString('hex')}`);

  // Strip WAV/RIFF header if xAI returned a container instead of raw mulaw
  if (audio.slice(0,4).toString('ascii') === 'RIFF') {
    const dataIdx = audio.indexOf(Buffer.from('data'));
    if (dataIdx !== -1) {
      audio = audio.slice(dataIdx + 8); // skip 'data' + 4-byte chunk size
      console.log(`[Ara TTS] stripped WAV header, raw mulaw bytes=${audio.length}`);
    }
  }
  return audio;
}

async function speakToCall(callId, text) {
  const session = jareihCalls.get(callId);
  if (!session || session.araMuted) return;
  if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
    console.warn('[Ara] WS not open for', callId, 'readyState=', session.ws?.readyState);
    return;
  }
  if (!session.streamSid) {
    console.warn('[Ara] No streamSid yet for', callId);
    return;
  }
  try {
    const audio = await araTTS(text);
    console.log(`[Ara speak] callId=${callId} streamSid=${session.streamSid} audioBytes=${audio.length}`);
    session.araLock++; // semaphore: increment when speaking starts

    // Twilio bidirectional streams require audio chunked in 20ms frames
    // mulaw 8000Hz = 8000 samples/sec × 1 byte/sample × 0.02s = 160 bytes per chunk
    const CHUNK_SIZE = 160;
    for (let i = 0; i < audio.length; i += CHUNK_SIZE) {
      const chunk = audio.slice(i, i + CHUNK_SIZE);
      session.ws.send(JSON.stringify({
        event: 'media',
        streamSid: session.streamSid,
        media: { payload: chunk.toString('base64') }
      }));
    }
    console.log(`[Ara speak] sent ${Math.ceil(audio.length / CHUNK_SIZE)} chunks`);

    // Send a mark event so we know when playback finishes
    const markLabel = `ara-done-${Date.now()}`;
    session.ws.send(JSON.stringify({ event: 'mark', streamSid: session.streamSid, mark: { name: markLabel } }));

    const clean = text.replace(/\[END_CALL\]|\[GOAL_ACHIEVED\]/g, '').trim();
    session.transcript.push({ role: 'ara', ts: Date.now(), text: clean });
    broadcastToAll({ type: 'jareih_call_update', callId, personId: session.personId, event: 'ara_spoke', text: clean });
    broadcastToAll({ type: 'jareih_active_calls', calls: getActiveCallsPayload() });
  } catch(e) { console.error('[Ara TTS]', e.message); }
}

// ─── Grok brain ───────────────────────────────────────────────────────────────
async function araRespond(callId, contactSpeech) {
  const session = jareihCalls.get(callId);
  if (!session || session.araMuted) return null;
  const grok = initGrok();
  if (!grok) return "Hello, thanks for answering. I'll follow up another time. Have a great day!";

  if (!session.grokHistory) {
    const ctx = session.context;
    const actSummary = (ctx.recentActivity||[]).slice(0,8).map(a=>`[${a.type}] ${(a.body||'').slice(0,120)}`).join('\n');
    const isInbound = session.direction === 'inbound';
    const guardrailBlock = getGuardrailPromptBlock();
    const systemContent = isInbound
      ? `You are Jireh (spelled Jareih), an AI assistant ANSWERING the phone for O.K.C. Real property management in Oklahoma City.

${guardrailBlock}

CALLER: ${ctx.name !== 'Unknown caller' ? ctx.name + ' (stage: ' + (ctx.stage||'Unknown') + ')' : 'Unknown caller — not in our system'}
${ctx.notes ? 'Notes: ' + ctx.notes : ''}

YOUR ROLE: Answer this inbound call, understand what the caller needs, and either help them directly or take a detailed message.

YOU CAN HELP WITH: leasing questions, scheduling tours, maintenance intake, payment questions, general O.K.C. Real info.

HOW TO TALK:
- Short, natural — 1-2 sentences. Let the conversation breathe.
- Warm and professional. React to what they say.
- ONE question at a time. No filler.
- Pure conversational spoken language — no markdown, no lists.

NAMES:
- You are "Jireh" — pronounced like the Hebrew word in "Jehovah Jireh"
- Company is always "O.K.C. Real" — spell it out, never "okcreal"

ENDING: When you have fully helped them or taken a complete message, close with:
"You've been speaking with Jireh, an A.I. assistant with O.K.C. Real. A team member will follow up soon. Have a great day!" then append [END_CALL]
If successfully helped: also append [GOAL_ACHIEVED]

If asked if you're AI: "Yeah, I'm Jireh — an A.I. assistant with O.K.C. Real. A real person will follow up with you too!"`
      : `You are Jireh (spelled Jareih), an AI assistant calling on behalf of O.K.C. Real property management in Oklahoma City.

${guardrailBlock}

WHO YOU ARE CALLING: ${ctx.name} (stage: ${ctx.stage||'Lead'})
YOUR GOAL FOR THIS CALL: ${session.goal}
Notes on this person: ${ctx.notes||'none'}
Recent activity with them:\n${actSummary||'none'}

YOUR PERSONALITY:
You are warm, relaxed, and genuinely friendly — like a real person making a quick call, not a robot reading a script.
Have a real conversation. Be curious about them. Listen. React naturally to what they say.
Your goal is to build a connection AND achieve the mission — do both together, not one after the other.

HOW TO TALK:
- Short, natural responses — 1-2 sentences usually. Let the conversation breathe.
- Use casual connectors: "yeah", "totally", "oh nice", "got it", "for sure" when they fit naturally
- React to what they actually said before moving to the next point
- Ask only ONE question at a time — never stack multiple questions
- No filler phrases like "Great!", "Absolutely!", "Certainly!" — just be natural
- No markdown, no lists — pure conversational spoken language

NAMES & PRONUNCIATION:
- Your name is "Jireh" (spelled Jareih) — pronounced like the Hebrew word in "Jehovah Jireh"
- The company is always "O.K.C. Real" — never "okcreal" or "aukreal", always spell it out

ENDING THE CALL:
- Only end when the goal is fully achieved OR the person clearly wants to go
- Always close with: "Again, this is Jireh with O.K.C. Real, an A.I. assistant. Please give us a call back if you have any questions. Goodbye!" then append [END_CALL]
- If goal was achieved, also append [GOAL_ACHIEVED]

If asked whether you are AI: "Yeah, I'm Jireh, an A.I. assistant with O.K.C. Real — but I promise I'm way more fun than most!"`;
    session.grokHistory = [{ role: 'system', content: systemContent }];
  }

  session.grokHistory.push({ role: 'user', content: contactSpeech || '[CALL_CONNECTED]' });
  const r = await grok.chat.completions.create({ model: 'grok-3', max_tokens: 120, messages: session.grokHistory });
  const raw = r.choices[0].message.content.trim();
  session.grokHistory.push({ role: 'assistant', content: raw });

  if (raw.includes('[END_CALL]'))      session.shouldEnd    = true;
  if (raw.includes('[GOAL_ACHIEVED]')) session.goalAchieved = true;

  const clean = raw.replace(/\[END_CALL\]|\[GOAL_ACHIEVED\]/g, '').trim();
  session.transcript.push({ role: 'ara', ts: Date.now(), text: clean });
  broadcastToAll({ type: 'jareih_call_update', callId, personId: session.personId, event: 'ara_spoke', text: clean });
  return clean;
}

// ─── Finalize — save to timeline ─────────────────────────────────────────────
async function finalizeJareihCall(callId, twilioStatus, duration) {
  const session = jareihCalls.get(callId);
  if (!session || session.finalized) return;
  session.finalized = true;

  const tookOver = session.transcript.some(t => t.role === 'agent');
  const label = tookOver ? 'Jareih AI Call (Agent Joined)' : 'Jareih AI Call';
  const goalTag = session.goalAchieved ? '✅ Goal Achieved' : twilioStatus === 'completed' ? '📋 Completed' : `⚠ ${twilioStatus}`;

  // Build plain transcript text for calls table
  const transcriptText = session.transcript
    .map(t => {
      const who = t.role === 'ara' ? 'Jareih (AI)' : t.role === 'agent' ? 'Agent' : session.context.name;
      return `${who}: ${t.text}`;
    })
    .join('\n');

  // Generate summary via Grok
  let summary = `${label} — ${goalTag}. Goal: ${session.goal}.`;
  if (transcriptText && initGrok()) {
    try {
      const grok = initGrok();
      const s = await grok.chat.completions.create({
        model: 'grok-3', max_tokens: 200,
        messages: [{ role: 'user', content:
          `Summarize this outbound AI call in 2-3 sentences. Goal: "${session.goal}". Achieved: ${session.goalAchieved ? 'Yes' : 'Unknown'}.\nTranscript:\n${transcriptText}` }]
      });
      summary = s.choices[0].message.content.trim();
    } catch(e) { console.error('[Jareih summary]', e.message); }
  }

  // Update calls row with transcript, summary, duration, status
  if (session.callDbId) {
    try {
      await pool.query(
        `UPDATE calls SET transcript=$1, summary=$2, duration_seconds=$3, status=$4, ended_at=NOW() WHERE id=$5`,
        [transcriptText || null, summary, duration || 0, twilioStatus, session.callDbId]
      );
    } catch(e) { console.error('[Jareih calls update]', e.message); }
  }

  // Activity body = compact header + summary (transcript/recording come via calls join)
  const activityBody = [
    `📞 ${label} — ${goalTag}`,
    `Goal: ${session.goal}`,
    '',
    summary
  ].join('\n');

  try {
    await pool.query(
      `INSERT INTO activities (person_id, agent_id, call_id, type, body, direction, duration, created_at)
       VALUES ($1, $2, $3, 'call', $4, 'outbound', $5, NOW())`,
      [session.personId, session.agentId, session.callDbId || null, activityBody, duration || 0]
    );
  } catch(e) { console.error('[Jareih activity insert]', e.message); }

  broadcastToAll({ type: 'jareih_call_update', callId, personId: session.personId, event: 'call_ended', summary, goalAchieved: session.goalAchieved, status: twilioStatus });
  jareihCalls.delete(callId);  // delete FIRST so getActiveCallsPayload returns accurate list
  broadcastToAll({ type: 'jareih_active_calls', calls: getActiveCallsPayload() });
}

// ─── Active calls list for the UI panel ──────────────────────────────────────
function getActiveCallsPayload() {
  return Array.from(jareihCalls.entries()).map(([callId, s]) => ({
    callId,
    personId: s.personId,
    contactName: s.context.name,
    contactPhone: s.context.phone,
    contactStage: s.context.stage,
    goal: s.goal,
    agentId: s.agentId,
    araActive: !s.araMuted,
    startedAt: s.startedAt,
    status: s.callStatus || 'initiated',
    answeredBy: s.answeredBy || null,
    isVoicemail: s.isVoicemail || false,
    transcript: s.transcript.slice(-20),
    listeners: s.listeners || []
  }));
}

// ─── WebSocket server: Twilio Media Streams ──────────────────────────────────
function setupJareihCallWS(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith('/ws/jareih-call/')) {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    }
  });

  wss.on('connection', async (ws, req) => {
    const callId = req.url.replace('/ws/jareih-call/','').split('?')[0];
    const session = jareihCalls.get(callId);
    if (!session) { ws.close(); return; }

    session.ws = ws;
    session.streamSid = null;
    session.araLock = 0;   // semaphore: >0 means Ara is busy (speaking or responding)

    // Deepgram STT
    const dgWs = new WebSocket(
      'wss://api.deepgram.com/v1/listen?' + [
        'encoding=mulaw','sample_rate=8000','channels=1','model=nova-2',
        'punctuate=true','smart_format=true','interim_results=true',
        'endpointing=600','utterance_end_ms=1200'
      ].join('&'),
      { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } }
    );
    dgWs.on('open', ()=>console.log(`[Ara] Deepgram connected callId=${callId}`));
    dgWs.on('message', async raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch(e) { return; }
      if (msg.type === 'Results' && msg.is_final) {
        const text = msg.channel?.alternatives?.[0]?.transcript?.trim();
        if (!text || session.araLock > 0 || session.araMuted) return;
        session.transcript.push({ role:'contact', ts:Date.now(), text });
        broadcastToAll({ type:'jareih_call_update', callId, personId:session.personId, event:'contact_spoke', text });
        session.araLock++;
        try {
          const response = await araRespond(callId, text);
          if (response) await speakToCall(callId, response);
          if (session.shouldEnd) {
            setTimeout(async () => {
              try {
                const tc = initTwilioFull();
                if (tc && session.contactCallSid) await tc.calls(session.contactCallSid).update({ status:'completed' });
              } catch(e) {}
            }, 1400);
          }
        } catch(e) { console.error('[Ara respond]', e.message); }
        finally { if (session.araLock > 0) session.araLock--; }
      }
    });
    dgWs.on('error', e => console.error('[Ara DG]', e.message));

    ws.on('message', async raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch(e) { return; }
      switch(msg.event) {
        case 'start':
          session.streamSid = msg.start?.streamSid || msg.streamSid;
          session.callStatus = 'connected';
          console.log(`[Ara WS] start callId=${callId} streamSid=${session.streamSid}`);
          broadcastToAll({ type:'jareih_call_update', callId, personId:session.personId, event:'status', status:'connected' });
          broadcastToAll({ type:'jareih_active_calls', calls: getActiveCallsPayload() });
          if (!session.greetingFired) {
            session.greetingFired = true;
            setTimeout(async () => {
              try {
                console.log(`[Ara] firing greeting callId=${callId}`);
                const greeting = await araRespond(callId, null);
                console.log(`[Ara] greeting text="${greeting?.slice(0,60)}"`);
                if (greeting) await speakToCall(callId, greeting);
              } catch(e) { console.error('[Ara greeting]', e.message); }
            }, 2000);
          }
          break;
        case 'mark':
          // Ara finished speaking — unlock so contact speech can trigger responses
          if (msg.mark?.name?.startsWith('ara-done-')) {
            if (session.araLock > 0) session.araLock--;
          }
          break;
        case 'media':
          if (dgWs.readyState === WebSocket.OPEN && msg.media?.payload) {
            dgWs.send(Buffer.from(msg.media.payload, 'base64'));
          }
          break;
        case 'stop':
          dgWs.close();
          break;
      }
    });
    ws.on('close', () => {
      dgWs.close();
      console.log(`[Ara] WS closed ${callId}`);
      // If call-status webhook didn't fire (caller hung up abruptly), finalize now
      const sess = jareihCalls.get(callId);
      if (sess && !sess.finalized) {
        const dur = sess.startedAt ? Math.round((Date.now() - sess.startedAt) / 1000) : 0;
        finalizeJareihCall(callId, 'completed', dur).catch(e => console.error('[Ara] WS close finalize error', e.message));
      }
    });
    ws.on('error', e => console.error('[Ara WS]', e.message));
  });
}

// ─── Conference token for monitoring agents ───────────────────────────────────
function buildConferenceToken(agentId, conferenceRoom) {
  const { AccessToken } = require('twilio').jwt;
  const { VoiceGrant } = AccessToken;
  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY_SID,
    process.env.TWILIO_API_KEY_SECRET,
    { identity: `monitor-${agentId}`, ttl: 3600 }
  );
  token.addGrant(new VoiceGrant({ outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID, incomingAllow: true }));
  return token.toJwt();
}

// ─── API: list active calls ───────────────────────────────────────────────────
app.get('/api/jareih/active-calls', auth, (req, res) => {
  res.json({ calls: getActiveCallsPayload() });
});

// ─── API: Initiate Jareih AI call ─────────────────────────────────────────────
app.post('/api/jareih/call', auth, async (req, res) => {
  const { personId, goal } = req.body;
  if (!personId || !goal) return res.status(400).json({ error: 'personId and goal required' });

  const personR = await pool.query('SELECT * FROM people WHERE id=$1', [personId]);
  const person = personR.rows[0];
  if (!person) return res.status(404).json({ error: 'Contact not found' });
  if (!person.phone) return res.status(400).json({ error: 'Contact has no phone number' });

  const actsR = await pool.query(
    `SELECT type,body,direction,created_at FROM activities WHERE person_id=$1 ORDER BY created_at DESC LIMIT 15`,
    [String(personId)]
  );
  const callId = `jc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

  jareihCalls.set(callId, {
    personId: String(personId),
    agentId: String(req.agent.id),
    goal,
    context: {
      name: `${person.first_name} ${person.last_name||''}`.trim(),
      phone: person.phone, stage: person.stage,
      notes: person.notes, email: person.email,
      recentActivity: actsR.rows
    },
    transcript: [],
    contactCallSid: null, aiBridgeCallSid: null,
    callDbId: null,   // UUID in calls table — linked to activity for playback
    araMuted: false, araActive: true,
    shouldEnd: false, goalAchieved: false, finalized: false,
    startedAt: Date.now(), callStatus: 'initiated',
    listeners: []
  });

  try {
    const tc = initTwilioFull();
    if (!tc) throw new Error('Twilio not configured');
    const fromNum = process.env.TWILIO_RESIDENT_NUMBER || '+14052562614';

    // Pre-insert calls row so we have a UUID to link activity to
    const callDbR = await pool.query(
      `INSERT INTO calls (twilio_call_sid, person_id, agent_id, direction, status, from_number, to_number, started_at, call_source)
       VALUES ($1, $2, $3, 'outbound', 'initiated', $4, $5, NOW(), 'jireh') RETURNING id`,
      ['pending-' + callId, String(personId), String(req.agent.id), fromNum, person.phone]
    );
    jareihCalls.get(callId).callDbId = callDbR.rows[0].id;

    const contactCall = await tc.calls.create({
      to: person.phone, from: fromNum,
      url: `${process.env.APP_URL}/api/jareih/contact-twiml/${callId}`,
      statusCallback: `${process.env.APP_URL}/api/jareih/call-status/${callId}`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated','ringing','answered','completed'],
      record: true,
      recordingStatusCallback: `${process.env.APP_URL}/api/twilio/recording`,
      recordingStatusCallbackMethod: 'POST',
      // AMD — wait for voicemail beep before connecting Jireh's audio stream
      machineDetection: 'DetectMessageEnd',
      machineDetectionTimeout: 30,
      machineDetectionSpeechThreshold: 2400,
      machineDetectionSpeechEndThreshold: 1200,
      machineDetectionSilenceTimeout: 5000,
      asyncAmdStatusCallback: `${process.env.APP_URL}/api/jareih/amd-result/${callId}`,
      asyncAmdStatusCallbackMethod: 'POST'
    });
    jareihCalls.get(callId).contactCallSid = contactCall.sid;

    // Update calls row with real Twilio SID
    await pool.query('UPDATE calls SET twilio_call_sid=$1 WHERE id=$2', [contactCall.sid, callDbR.rows[0].id]);

    broadcastToAll({ type:'jareih_active_calls', calls: getActiveCallsPayload() });
    res.json({ ok:true, callId, contactCallSid:contactCall.sid, contactName:person.first_name });
  } catch(e) {
    jareihCalls.delete(callId);
    res.status(500).json({ error: e.message });
  }
});

// Contact TwiML — bidirectional stream: contact audio in via WS, Ara audio back via WS
app.all('/api/jareih/contact-twiml/:callId', (req, res) => {
  const { callId } = req.params;
  const wsBase = (process.env.APP_URL||'').replace('https://','wss://').replace('http://','ws://');
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsBase}/ws/jareih-call/${callId}">
      <Parameter name="callId" value="${callId}"/>
    </Stream>
  </Connect>
</Response>`);
});

// AI bridge TwiML — joins the same conference so the contact can hear Ara
app.all('/api/jareih/ai-bridge-twiml/:callId', (req, res) => {
  const { callId } = req.params;
  const confName = jcConferenceName(callId);
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference beep="false" startConferenceOnEnter="false" endConferenceOnExit="false">${confName}</Conference>
  </Dial>
</Response>`);
});

// Conference events callback
app.post('/api/jareih/conf-events/:callId', (req, res) => {
  res.sendStatus(200);
  const { callId } = req.params;
  const { StatusCallbackEvent, CallSid, ConferenceSid } = req.body;
  const session = jareihCalls.get(callId);
  if (!session) return;
  // Capture the real ConferenceSid the first time we see it — needed for announceUrl
  if (ConferenceSid && !session.conferenceSid) {
    session.conferenceSid = ConferenceSid;
    console.log(`[Ara conf] Got conferenceSid=${ConferenceSid} callId=${callId}`);
  }
  console.log(`[Ara conf] ${StatusCallbackEvent} callId=${callId}`);
});

// Serve TTS audio as MP3
app.get('/api/jareih/tts/:token.mp3', (req, res) => {
  const buf = ttsAudioCache.get(req.params.token);
  if (!buf) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
});

// TwiML wrapper — announceUrl must return TwiML, not raw audio
app.get('/api/jareih/tts-twiml/:token', (req, res) => {
  const buf = ttsAudioCache.get(req.params.token);
  if (!buf) { res.type('text/xml'); return res.send('<Response/>'); }
  const audioUrl = `${process.env.APP_URL}/api/jareih/tts/${req.params.token}.mp3`;
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Play>${audioUrl}</Play></Response>`);
});

// ── Browser-friendly TTS (WAV) for voice chat ──────────────────────────────
async function araTTSBrowser(text) {
  // Use the SAME araTTS function that works for phone calls,
  // then wrap raw mulaw in a WAV header so browsers can decode it
  console.log(`[Ara TTS Browser] Generating for: "${text.substring(0,60)}…"`);
  const raw = await araTTS(text);
  console.log(`[Ara TTS Browser] Got ${raw.length} raw mulaw bytes — wrapping in WAV`);
  const wavBuf = wrapMulawWav(raw, 8000);
  console.log(`[Ara TTS Browser] WAV ready: ${wavBuf.length} bytes`);
  return { buffer: wavBuf, mime: 'audio/wav' };
}

// Decode mulaw to 16-bit PCM and wrap in a standard WAV that every browser supports
function wrapMulawWav(rawMulaw, sampleRate) {
  // ITU-T G.711 mulaw → linear PCM16 decoder (reference implementation)
  function mulawDecode(byte) {
    byte = ~byte & 0xFF;
    const sign = byte & 0x80;
    const exponent = (byte >> 4) & 0x07;
    const mantissa = byte & 0x0F;
    let sample = ((mantissa << 3) + 0x84) << exponent; // <<3 NOT <<4
    return sign ? (0x84 - sample) : (sample - 0x84);   // max ±32124, fits int16
  }

  const numSamples = rawMulaw.length;
  const pcmData = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    pcmData.writeInt16LE(mulawDecode(rawMulaw[i]), i * 2);
  }

  const header = Buffer.alloc(44);
  const dataLen = pcmData.length;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);           // PCM format
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcmData]);
}

app.get('/api/jareih/voice-audio/:token', (req, res) => {
  const key = 'voice-' + req.params.token.replace(/\.\w+$/, '');
  const entry = ttsAudioCache.get(key);
  if (!entry) { console.warn('[Voice Audio] 404 for token:', req.params.token); return res.status(404).end(); }
  const { buffer, mime } = (typeof entry === 'object' && entry.buffer) ? entry : { buffer: entry, mime: 'audio/wav' };
  console.log(`[Voice Audio] Serving ${buffer.length} bytes as ${mime} for token ${req.params.token}`);
  res.setHeader('Content-Type', mime || 'audio/wav');
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Accept-Ranges', 'bytes');
  res.send(buffer);
  setTimeout(() => ttsAudioCache.delete(key), 60000);
});

// ── Voice Chat endpoint — conversational AI with CRM context + Ara voice ───
app.post('/api/jareih/voice-chat', auth, async (req, res) => {
  try {
    const { text, history } = req.body;
    console.log(`[Voice Chat] Request from ${req.agent?.name}: "${(text||'').substring(0,80)}"`);
    if (!text) return res.status(400).json({ error: 'No text' });

    const agentName = req.agent?.name || 'there';
    const agentFirst = agentName.split(' ')[0];

    // Scripture guardrail check
    const guardrailCheck = checkScriptureGuardrails(text);
    if (guardrailCheck.blocked) {
      const reply = guardrailCheck.message;
      let audioToken = null;
      try {
        const audio = await araTTSBrowser(reply.substring(0, 300));
        audioToken = crypto.randomBytes(8).toString('hex');
        ttsAudioCache.set('voice-' + audioToken, audio);
      } catch(e) { console.warn('[Voice TTS]', e.message); }
      return res.json({ text: reply, audioToken, guardrail: true });
    }

    const grok = initGrok();
    if (!grok) return res.status(503).json({ error: 'AI not configured' });

    // Gather CRM context
    const [stagesR, recentR, openWoR, rentRollR, peopleR] = await Promise.all([
      pool.query(`SELECT stage, COUNT(*)::int AS cnt FROM people GROUP BY stage ORDER BY cnt DESC`).catch(() => ({ rows: [] })),
      pool.query(`SELECT type, COUNT(*)::int AS cnt FROM activities WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY type`).catch(() => ({ rows: [] })),
      pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE scheduled_end IS NOT NULL AND scheduled_end + INTERVAL '6 hours' < NOW()) AS overdue, COUNT(*) FILTER (WHERE scheduled_end IS NULL) AS unscheduled FROM work_orders WHERE status NOT IN ('Completed','Completed No Need To Bill','Canceled','Cancelled')`).catch(() => ({ rows: [{}] })),
      pool.query(`SELECT COUNT(*)::int AS occupied FROM rent_roll WHERE status='Current'`).catch(() => ({ rows: [{}] })),
      pool.query(`SELECT id, first_name, last_name, stage, phone FROM people ORDER BY updated_at DESC LIMIT 200`).catch(() => ({ rows: [] })),
    ]);

    const stageBreakdown = stagesR.rows.map(r => `${r.stage||'Unknown'}: ${r.cnt}`).join(', ');
    const activityToday = recentR.rows.map(r => `${r.type}: ${r.cnt}`).join(', ') || 'none yet today';
    const wo = openWoR.rows[0] || {};
    const occupied = rentRollR.rows[0]?.occupied || '?';
    const today = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    const peopleSample = peopleR.rows.slice(0, 150).map(p => `${p.id}|${p.first_name} ${p.last_name||''}|${p.stage||''}`).join('\n');

    const systemPrompt = `You are Jireh (spelled Jareih), a voice AI assistant for OKCREAL Connect property management CRM.
You are speaking with ${agentName}, an agent on the team. Address them as "${agentFirst}" naturally in conversation.

Today is ${today}.

${getGuardrailPromptBlock()}

CRM SNAPSHOT:
- Pipeline: ${stageBreakdown}
- Activity today: ${activityToday}
- Open work orders: ${wo.total||0} total (${wo.overdue||0} overdue, ${wo.unscheduled||0} unscheduled)
- Occupied units: ${occupied}

PEOPLE IN CRM (id|name|stage — first 150):
${peopleSample}

CRM NAVIGATION — You can navigate the CRM for the agent. When they ask you to pull up a page, open a file, show something, etc., include an ACTION line at the VERY END of your spoken response, on its own line, in this exact format:
[ACTION:open_contact:PERSON_ID] — opens a person's file (use the person ID from the people list above)
[ACTION:navigate:people] — go to All People
[ACTION:navigate:dashboard] — go to Command Module
[ACTION:navigate:showings] — go to Showings
[ACTION:navigate:inbox] — go to Inbox
[ACTION:navigate:workorders] — go to Work Orders
[ACTION:navigate:admin] — go to Admin
[ACTION:navigate:security] — go to Security Alerts
[ACTION:navigate:callreports] — go to Call Reports
[ACTION:search:QUERY] — search for a person by name, phone, or address

RULES FOR ACTIONS:
- ONLY include an action if the agent explicitly asks to navigate, open, or pull up something
- Match person names fuzzily — if they say "Landon" find the best match in the people list
- The ACTION line must be the LAST line of your response, nothing after it
- Your spoken text should confirm what you're doing, like "Sure, pulling up Landon's file now."
- If you can't find the person, say so and offer to search

YOUR PERSONALITY:
- Warm, natural, conversational — like a trusted coworker who knows the business inside and out
- Use ${agentFirst}'s name occasionally (not every response — keep it natural)
- Short responses — 2-3 sentences usually. This is a voice conversation, not an essay.
- React to what they say before giving info. Be a real conversationalist.
- When you don't know something specific, say so honestly and suggest where to look.
- You can help with: CRM strategy, tenant questions, work order triage, showing follow-up advice, team priorities, property insights, AND navigating the CRM.
- Keep it spoken-language natural — no lists, no markdown, no formatting. Just talk.

Remember: you represent a company built on biblical values. Be excellent, be warm, be wise.`;

    const messages = [{ role: 'system', content: systemPrompt }];
    if (Array.isArray(history)) {
      for (const m of history.slice(-12)) {
        if (m.role && m.content) messages.push({ role: m.role, content: String(m.content) });
      }
    }
    messages.push({ role: 'user', content: text });

    const completion = await grok.chat.completions.create({
      model: 'grok-3', max_tokens: 300, messages
    });

    let reply = completion.choices[0].message.content.trim();

    // ── Parse action from response ──
    let action = null;
    const actionMatch = reply.match(/\[ACTION:(\w+):(.+?)\]\s*$/);
    if (actionMatch) {
      const [fullMatch, actionType, actionParam] = actionMatch;
      reply = reply.replace(fullMatch, '').trim(); // strip action from spoken text
      if (actionType === 'open_contact') {
        action = { type: 'open_contact', params: { personId: actionParam } };
      } else if (actionType === 'navigate') {
        action = { type: 'navigate', params: { view: actionParam } };
      } else if (actionType === 'search') {
        action = { type: 'search', params: { query: actionParam } };
      }
      console.log(`[Voice Chat] Action detected: ${actionType}:${actionParam}`);
    }

    // ── Pronunciation fix for TTS ──
    // "Jireh" should sound like "Jy-ruh" (as in Jehovah Jireh), not "Jah-ree"
    let ttsText = reply
      .replace(/\bJireh\b/gi, 'Jy-ruh')
      .replace(/\bJareih\b/gi, 'Jy-ruh')
      .replace(/\bO\.K\.C\.\s*Real\b/gi, 'O K C Real');

    // Generate Ara voice audio
    let audioToken = null;
    try {
      const audio = await araTTSBrowser(ttsText);
      audioToken = crypto.randomBytes(8).toString('hex');
      ttsAudioCache.set('voice-' + audioToken, audio);
      console.log(`[Voice Chat] ${agentFirst}: "${text.substring(0,50)}" → Ara: "${reply.substring(0,50)}…" audio=${audio.buffer.length}b ${audio.mime}`);
    } catch(ttsErr) {
      console.warn('[Voice TTS] Audio gen failed, text-only fallback:', ttsErr.message);
    }

    res.json({ text: reply, audioToken, action });
  } catch(e) {
    console.error('[Voice Chat]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Contact/status callback
app.post('/api/jareih/call-status/:callId', async (req, res) => {
  res.sendStatus(200);
  const { callId } = req.params;
  const { CallStatus, CallDuration } = req.body;
  const session = jareihCalls.get(callId);
  if (!session) return;
  session.callStatus = CallStatus;
  if (['completed','failed','busy','no-answer','canceled'].includes(CallStatus)) {
    await finalizeJareihCall(callId, CallStatus, parseInt(CallDuration)||0);
  } else {
    broadcastToAll({ type:'jareih_call_update', callId, personId:session.personId, event:'status', status:CallStatus });
    broadcastToAll({ type:'jareih_active_calls', calls: getActiveCallsPayload() });
  }
});

app.post('/api/jareih/ai-bridge-status/:callId', (req, res) => { res.sendStatus(200); });

// ─── AMD (Answering Machine Detection) result ────────────────────────────────
app.post('/api/jareih/amd-result/:callId', (req, res) => {
  res.sendStatus(200);
  const { callId } = req.params;
  const { AnsweredBy, CallSid } = req.body;
  const session = jareihCalls.get(callId);
  if (!session) return;

  session.answeredBy = AnsweredBy; // 'human', 'machine_start', 'machine_end_beep', 'machine_end_silence', 'machine_end_other', 'fax', 'unknown'
  console.log(`[Jireh AMD] Call ${callId} answered by: ${AnsweredBy}`);

  const isMachine = AnsweredBy && AnsweredBy.startsWith('machine');
  if (isMachine) {
    // Inject context so Jireh knows it's leaving a voicemail
    session.isVoicemail = true;
    if (session.grokHistory) {
      session.grokHistory.push({
        role: 'system',
        content: '[VOICEMAIL DETECTED] You reached a voicemail. Leave a brief, professional voicemail message. State your name (Jireh from OKCREAL), the reason for calling, and ask them to call back. Keep it under 30 seconds. Do NOT have a conversation — just leave the message and end the call.'
      });
    }
    session.transcript.push({ role: 'system', ts: Date.now(), text: `[AMD: ${AnsweredBy} — voicemail mode activated]` });
    broadcastToAll({ type: 'jareih_call_update', callId, personId: session.personId, event: 'voicemail_detected', answeredBy: AnsweredBy });
  } else {
    session.isVoicemail = false;
    session.transcript.push({ role: 'system', ts: Date.now(), text: `[AMD: ${AnsweredBy} — human detected]` });
  }
  broadcastToAll({ type: 'jareih_active_calls', calls: getActiveCallsPayload() });
});

// ─── Mute / unmute Ara ────────────────────────────────────────────────────────
app.post('/api/jareih/toggle-ara', auth, async (req, res) => {
  const { callId, mute } = req.body;
  const session = jareihCalls.get(callId);
  if (!session) return res.status(404).json({ error: 'Call not found' });
  session.araMuted = !!mute;
  session.araActive = !mute;
  if (mute && session.ws && session.ws.readyState === WebSocket.OPEN) {
    // Silence Ara immediately
    session.ws.send(JSON.stringify({ event:'clear', streamSid:session.streamSid }));
  }
  broadcastToAll({ type:'jareih_call_update', callId, personId:session.personId, event:'ara_toggle', araMuted:session.araMuted });
  broadcastToAll({ type:'jareih_active_calls', calls: getActiveCallsPayload() });
  res.json({ ok:true, araMuted:session.araMuted });
});

// ─── Coach Ara mid-call ───────────────────────────────────────────────────────
app.post('/api/jareih/coach', auth, async (req, res) => {
  const { callId, message } = req.body;
  const session = jareihCalls.get(callId);
  if (!session) return res.status(404).json({ error: 'Call not found' });
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });
  // Inject as a system nudge into Ara's conversation history
  if (!session.grokHistory) return res.status(400).json({ error: 'Call not yet active' });
  session.grokHistory.push({
    role: 'system',
    content: `[AGENT COACHING — respond to this immediately]: ${message.trim()}`
  });
  session.transcript.push({ role: 'agent', ts: Date.now(), text: `[Coach → Ara]: ${message.trim()}` });
  broadcastToAll({ type: 'jareih_call_update', callId, personId: session.personId, event: 'coach', text: message.trim(), agentName: req.agent.name });
  // Trigger Ara to respond now based on coaching
  try {
    if (session.araLock === 0 && !session.araMuted) {
      session.araLock++;
      const response = await araRespond(callId, `[AGENT SAYS]: ${message.trim()}`);
      if (response) await speakToCall(callId, response);
    }
  } catch(e) { console.error('[Coach]', e.message); }
  finally { if (session && session.araLock > 0) session.araLock--; }
  res.json({ ok: true });
});

// ─── Agent join the conference (listen or speak) ──────────────────────────────
app.post('/api/jareih/call-join', auth, async (req, res) => {
  const { callId, mode } = req.body; // mode: 'listen' | 'speak'
  const session = jareihCalls.get(callId);
  if (!session) return res.status(404).json({ error: 'Call not found' });
  if (!process.env.TWILIO_API_KEY_SID) return res.status(503).json({ error:'Twilio API Key not configured' });
  try {
    const confName = jcConferenceName(callId);
    const muted = mode !== 'speak';
    const tc = initTwilioFull();

    // Move the contact's call into a conference so agent can hear/join
    // This ends the WebSocket stream (Ara goes silent) and bridges contact audio to a real conference
    if (tc && session.contactCallSid) {
      const confTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true"
      statusCallback="${process.env.APP_URL}/api/jareih/conf-events/${callId}"
      statusCallbackEvent="start end join leave">${confName}</Conference>
  </Dial>
</Response>`;
      try {
        await tc.calls(session.contactCallSid).update({ twiml: confTwiml });
        // Ara is now silent (stream ended) — mark session accordingly
        session.araMuted = true;
        session.araActive = false;
        console.log(`[Join] Redirected contact ${session.contactCallSid} to conference ${confName}`);
      } catch(e) {
        console.error('[Join] Failed to redirect contact to conference:', e.message);
        // Fall through — still give agent the token so they can try
      }
    }

    const token = buildConferenceToken(req.agent.id, confName);

    if (!muted) {
      session.transcript.push({ role:'agent', ts:Date.now(), text:'[Agent joined and took over]' });
      broadcastToAll({ type:'jareih_call_update', callId, personId:session.personId, event:'agent_joined', agentId:req.agent.id, agentName:req.agent.name, muted });
    } else {
      session.listeners = session.listeners || [];
      if (!session.listeners.find(l => l.agentId === String(req.agent.id))) {
        session.listeners.push({ agentId:String(req.agent.id), name:req.agent.name });
      }
      broadcastToAll({ type:'jareih_call_update', callId, personId:session.personId, event:'agent_listening', agentId:req.agent.id, agentName:req.agent.name });
    }
    broadcastToAll({ type:'jareih_active_calls', calls: getActiveCallsPayload() });
    res.json({ ok:true, token, confName, muted });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ─── Hang up ──────────────────────────────────────────────────────────────────
app.post('/api/jareih/call-hangup', auth, async (req, res) => {
  const { callId } = req.body;
  const session = jareihCalls.get(callId);
  if (!session) return res.status(404).json({ error:'Call not found' });
  try {
    const tc = initTwilioFull();
    if (tc) {
      if (session.contactCallSid)  await tc.calls(session.contactCallSid).update({ status:'completed' }).catch(()=>{});
      if (session.aiBridgeCallSid) await tc.calls(session.aiBridgeCallSid).update({ status:'completed' }).catch(()=>{});
    }
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ─── Bring Ara into an existing regular call ──────────────────────────────────
// Agent is on a call (callSid known), they want Ara to assist or take over
app.post('/api/jareih/inject-ara', auth, async (req, res) => {
  const { callSid, personId, goal } = req.body;
  if (!callSid || !personId || !goal) return res.status(400).json({ error:'callSid, personId, goal required' });

  const personR = await pool.query('SELECT * FROM people WHERE id=$1', [personId]);
  const person = personR.rows[0];
  if (!person) return res.status(404).json({ error:'Contact not found' });

  const actsR = await pool.query(
    `SELECT type,body,direction,created_at FROM activities WHERE person_id=$1 ORDER BY created_at DESC LIMIT 15`,
    [String(personId)]
  );
  const callId = `jc-inject-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

  jareihCalls.set(callId, {
    personId: String(personId),
    agentId: String(req.agent.id),
    goal,
    context: {
      name: `${person.first_name} ${person.last_name||''}`.trim(),
      phone: person.phone, stage: person.stage,
      notes: person.notes, email: person.email,
      recentActivity: actsR.rows
    },
    transcript: [{ role:'agent', ts:Date.now(), text:'[Agent was on call — injected Ara AI]' }],
    contactCallSid: callSid, aiBridgeCallSid: null,
    araMuted: false, araActive: true,
    shouldEnd: false, goalAchieved: false, finalized: false,
    startedAt: Date.now(), callStatus: 'connected', listeners: []
  });

  try {
    const tc = initTwilioFull();
    if (!tc) throw new Error('Twilio not configured');
    const fromNum = process.env.TWILIO_RESIDENT_NUMBER || '+14052562614';

    // Move the existing call into a conference
    await tc.calls(callSid).update({
      url: `${process.env.APP_URL}/api/jareih/contact-twiml/${callId}`,
      method: 'POST'
    });

    // Launch AI bridge into same conference
    const aiCall = await tc.calls.create({
      to: fromNum, from: fromNum,
      url: `${process.env.APP_URL}/api/jareih/ai-bridge-twiml/${callId}`,
      statusCallback: `${process.env.APP_URL}/api/jareih/ai-bridge-status/${callId}`,
      statusCallbackMethod: 'POST'
    });
    jareihCalls.get(callId).aiBridgeCallSid = aiCall.sid;

    broadcastToAll({ type:'jareih_active_calls', calls: getActiveCallsPayload() });
    res.json({ ok:true, callId });
  } catch(e) {
    jareihCalls.delete(callId);
    res.status(500).json({ error: e.message });
  }
});


checkDB().then(() => initDB()).then(() => {
  // Lead scraper — moved here so it only starts after DB is fully initialized
  initLeadScraper();

  // ── Work Order Alert System — DB migration + 30-min reclassification poller ──
  initWorkOrderAlerts(pool).catch(e => console.warn('[WO Migration]', e.message));
  // Reclassify alerts every 30 min + 30s after boot
  const _woReclassify = async () => {
    try {
      const { rows } = await pool.query(`SELECT id, status, scheduled_end, created_at FROM work_orders WHERE status NOT IN ('Completed','Completed No Need To Bill','Canceled','Cancelled')`);
      for (const wo of rows) {
        const alert = classifyWOAlert(wo);
        const daysOpen = wo.created_at ? Math.round(((Date.now()-new Date(wo.created_at).getTime())/86400000)*10)/10 : null;
        await pool.query('UPDATE work_orders SET alert_state=$1, days_open=$2 WHERE id=$3', [alert, daysOpen, wo.id]);
      }
      await pool.query(`UPDATE work_orders SET alert_state='COMPLETED' WHERE status IN ('Completed','Completed No Need To Bill','Canceled','Cancelled') AND alert_state!='COMPLETED'`);
    } catch(e) { console.warn('[WO Reclassify]', e.message); }
  };
  setInterval(_woReclassify, 30 * 60 * 1000);
  setTimeout(_woReclassify, 30000);

  // Showing followup text poller — runs every 2 minutes
  setInterval(pollShowingFollowups, 2 * 60 * 1000);
  setTimeout(pollShowingFollowups, 10000); // first check 10s after boot

  // Weather alert poller — every 5 min
  setInterval(refreshWeatherCache, 5 * 60 * 1000);
  setTimeout(refreshWeatherCache, 5000); // first check 5s after boot

  // Attach Jareih call WebSocket server
  setupJareihCallWS(httpServer);

  httpServer.listen(PORT, () => {
    console.log(`OKCREAL Connect running on port ${PORT}`);
    console.log(`Twilio Account:  ${process.env.TWILIO_ACCOUNT_SID ? '✓' : '✗'}`);
    console.log(`Twilio API Key:  ${process.env.TWILIO_API_KEY_SID ? '✓' : '✗'}`);
    console.log(`Twilio Auth Tok: ${process.env.TWILIO_AUTH_TOKEN ? '✓' : '✗ (not needed if API Key set)'}`);
    console.log(`Twilio RecAuth:  ${twilioBasicAuth() ? '✓ ready' : '✗ NO CREDENTIALS - recordings will fail'}`);
    console.log(`Deepgram: ${process.env.DEEPGRAM_API_KEY ? '✓' : '✗'}`);
    console.log(`Grok:     ${process.env.GROK_API_KEY ? '✓' : '✗'}`);
    console.log(`Jareih AI Calls: ${process.env.DEEPGRAM_API_KEY && process.env.GROK_API_KEY ? '✓ ready' : '✗ needs DEEPGRAM + GROK keys'}`);
  });
}).catch(err => {
  console.error('[FATAL] Startup failed:', err?.stack || err);
  process.exit(1);
}); // end checkDB().then(() => initDB()).then
