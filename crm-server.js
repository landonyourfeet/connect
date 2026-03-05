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
    try
