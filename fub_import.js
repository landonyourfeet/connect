#!/usr/bin/env node
/**
 * OKCREAL Connect — Follow Up Boss Import
 * Usage:
 *   node fub_import.js contacts.csv          ← dry run (no DB writes)
 *   node fub_import.js contacts.csv --commit  ← actually imports
 *
 * Requires: DATABASE_URL env var (same as Railway)
 */

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

// ── CONFIG ──────────────────────────────────────────────────────────────────
const DRY_RUN = !process.argv.includes('--commit');
const CSV_FILE = process.argv[2];

if (!CSV_FILE) {
  console.error('Usage: node fub_import.js <contacts.csv> [--commit]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL env var not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── STAGE MAPPING ───────────────────────────────────────────────────────────
// FUB stage → OKCREAL Connect stage
function mapStage(fubStage) {
  const s = (fubStage || '').toLowerCase().trim();
  if (!s) return 'Lead';
  if (['hot','warm','cold','nurture','active','rental prospect','prospect','new','uncontacted','attempted contact','pre-approval','showing scheduled'].includes(s)) return 'Lead';
  if (['past client','past tenant','past buyer','past seller'].includes(s)) return 'Past Tenant';
  if (['closed','purchased','sold'].includes(s)) return 'Past Tenant';
  if (['owner','property owner','landlord'].includes(s)) return 'Property Owner';
  if (['resident','tenant','active tenant','current tenant'].includes(s)) return 'Resident';
  if (['contractor','vendor','maintenance'].includes(s)) return 'Contractor';
  if (['caseworker','case worker','social worker','hap','section 8'].includes(s)) return 'Caseworker';
  if (['trash','do not contact','dnc','spam','blocked'].includes(s)) return 'Lead'; // imported but blocked
  return 'Lead'; // default fallback
}

function isTrash(fubStage) {
  const s = (fubStage || '').toLowerCase().trim();
  return ['trash','do not contact','dnc','spam','blocked'].includes(s);
}

// ── CSV PARSER ───────────────────────────────────────────────────────────────
function parseCSV(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = parseCSVLine(line);
    const row = {};
    headers.forEach((h, j) => { row[h] = (vals[j] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

// ── PHONE NORMALIZER ─────────────────────────────────────────────────────────
function normalizePhone(ph) {
  if (!ph) return null;
  const digits = ph.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

// ── DOB PARSER ───────────────────────────────────────────────────────────────
function parseDOB(val) {
  if (!val) return null;
  // Try MM/DD/YYYY or YYYY-MM-DD
  const mmddyyyy = val.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mmddyyyy) return `${mmddyyyy[3]}-${mmddyyyy[1].padStart(2,'0')}-${mmddyyyy[2].padStart(2,'0')}`;
  const yyyymmdd = val.match(/^\d{4}-\d{2}-\d{2}$/);
  if (yyyymmdd) return val;
  return null;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  OKCREAL Connect — FUB Import');
  console.log(`  Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes written)' : '🚀 LIVE COMMIT'}`);
  console.log('═══════════════════════════════════════════════════════\n');

  const rows = parseCSV(CSV_FILE);
  console.log(`📋 Loaded ${rows.length} rows from CSV\n`);

  // Load existing people for dedup (by phone and email)
  const existingByPhone = new Map();
  const existingByEmail = new Map();
  const existingByFubId = new Map();
  const { rows: existing } = await pool.query(`
    SELECT p.id, p.first_name, p.last_name, p.email, p.fub_id,
           array_agg(pp.phone) FILTER (WHERE pp.phone IS NOT NULL) AS phones
    FROM people p
    LEFT JOIN person_phones pp ON pp.person_id = p.id
    GROUP BY p.id
  `);
  for (const p of existing) {
    if (p.fub_id) existingByFubId.set(p.fub_id, p.id);
    if (p.email) existingByEmail.set(p.email.toLowerCase(), p.id);
    for (const ph of (p.phones || [])) {
      const norm = normalizePhone(ph);
      if (norm) existingByPhone.set(norm, p.id);
    }
  }
  console.log(`📊 Existing contacts in DB: ${existing.length}\n`);

  // Counters
  let toInsert = 0, toSkip = 0, toUpdate = 0, blocked = 0;
  const skippedNames = [], blockedNames = [], insertNames = [], updateNames = [];

  const ops = []; // deferred DB operations

  for (const row of rows) {
    const firstName = row['First Name'] || row['Name']?.split(' ')[0] || '';
    const lastName  = row['Last Name']  || row['Name']?.split(' ').slice(1).join(' ') || '';
    const fubId     = row['ID'] || null;
    const email     = (row['Email 1'] || '').toLowerCase() || null;
    const phone     = normalizePhone(row['Phone 1'] || '');
    const phoneType = row['Phone 1 - Type'] || 'mobile';
    const fubStage  = row['Stage'] || '';
    const stage     = mapStage(fubStage);
    const blocked   = isTrash(fubStage);
    const source    = row['Lead Source'] || null;
    const assignedTo = row['Assigned To'] || null;
    const tags      = row['Tags'] ? row['Tags'].split(',').map(t => t.trim()).filter(Boolean) : [];
    const notes     = [row['Notes'], row['Description'], row['Background']].filter(Boolean).join('\n\n') || null;
    const dob       = parseDOB(row['DOB:'] || row['Birthday'] || '');

    // Address: use Property Address fields
    const address = row['Property Address'] || null;
    const city    = row['Property City'] || null;
    const state   = row['Property State'] || null;
    const zip     = row['Property Postal Code'] || null;

    if (!firstName) { toSkip++; skippedNames.push(`[no name] fub_id=${fubId}`); continue; }

    // Dedup check: fub_id > email > phone
    let existingId = null;
    if (fubId && existingByFubId.has(fubId))         existingId = existingByFubId.get(fubId);
    else if (email && existingByEmail.has(email))     existingId = existingByEmail.get(email);
    else if (phone && existingByPhone.has(phone))     existingId = existingByPhone.get(phone);

    const fullName = `${firstName} ${lastName}`.trim();

    if (existingId) {
      // UPDATE — only update fields that are useful, don't overwrite good data
      toUpdate++;
      updateNames.push(`${fullName} (id=${existingId})`);
      if (!DRY_RUN) {
        ops.push(async () => {
          await pool.query(`
            UPDATE people SET
              fub_id = COALESCE(fub_id, $1),
              dob = COALESCE(dob, $2),
              source = COALESCE(source, $3),
              notes = COALESCE(notes, $4),
              is_blocked = is_blocked OR $5,
              updated_at = NOW()
            WHERE id = $6
          `, [fubId, dob, source, notes, blocked, existingId]);
          // Add phone if not already there
          if (phone) {
            await pool.query(`
              INSERT INTO person_phones (person_id, phone, label, is_primary)
              VALUES ($1, $2, $3, false)
              ON CONFLICT DO NOTHING
            `, [existingId, phone, phoneType]);
          }
        });
      }
    } else {
      toInsert++;
      insertNames.push(`${fullName} → ${stage}${blocked ? ' 🚫 BLOCKED' : ''}`);
      if (!DRY_RUN) {
        ops.push(async () => {
          const { rows: [newPerson] } = await pool.query(`
            INSERT INTO people
              (first_name, last_name, email, stage, source, assigned_to, tags, notes,
               dob, fub_id, is_blocked, address, city, state, zip, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
            RETURNING id
          `, [firstName, lastName, email||null, stage, source, assignedTo,
              tags, notes, dob, fubId, blocked,
              address, city, state, zip]);
          // Insert phone
          if (phone && newPerson) {
            await pool.query(`
              INSERT INTO person_phones (person_id, phone, label, is_primary)
              VALUES ($1, $2, $3, true)
              ON CONFLICT DO NOTHING
            `, [newPerson.id, phone, phoneType]);
          }
        });
      }
    }

    if (blocked) blockedNames.push(fullName);
  }

  // ── SUMMARY ────────────────────────────────────────────────────────────────
  console.log('┌─────────────────────────────────────────────────────┐');
  console.log('│                   IMPORT SUMMARY                   │');
  console.log('├─────────────────────────────────────────────────────┤');
  console.log(`│  ✅ To insert (new contacts):    ${String(toInsert).padStart(5)}               │`);
  console.log(`│  🔄 To update (already exist):   ${String(toUpdate).padStart(5)}               │`);
  console.log(`│  🚫 Blocked (Trash stage):        ${String(blockedNames.length).padStart(5)}               │`);
  console.log(`│  ⏭  Skipped (no name):           ${String(toSkip).padStart(5)}               │`);
  console.log('└─────────────────────────────────────────────────────┘\n');

  if (insertNames.length) {
    console.log(`\n📥 NEW CONTACTS (${insertNames.length}):`);
    insertNames.forEach(n => console.log('   +', n));
  }
  if (updateNames.length) {
    console.log(`\n🔄 UPDATES (${updateNames.length}):`);
    updateNames.slice(0, 20).forEach(n => console.log('   ~', n));
    if (updateNames.length > 20) console.log(`   ... and ${updateNames.length - 20} more`);
  }
  if (blockedNames.length) {
    console.log(`\n🚫 BLOCKED CONTACTS (${blockedNames.length}):`);
    blockedNames.forEach(n => console.log('   ✗', n));
  }
  if (skippedNames.length) {
    console.log(`\n⏭  SKIPPED (${skippedNames.length}):`);
    skippedNames.forEach(n => console.log('   -', n));
  }

  if (DRY_RUN) {
    console.log('\n\n⚠️  DRY RUN — nothing was written to the database.');
    console.log('   Run with --commit to apply:\n');
    console.log(`   DATABASE_URL=... node fub_import.js ${CSV_FILE} --commit\n`);
  } else {
    // Execute all ops sequentially
    console.log('\n⏳ Writing to database...');
    let done = 0;
    for (const op of ops) {
      await op();
      done++;
      if (done % 50 === 0) process.stdout.write(`\r   ${done}/${ops.length} written...`);
    }
    console.log(`\r   ✅ ${done} operations complete.        \n`);
    console.log('🎉 Import finished successfully!\n');
  }

  await pool.end();
}

main().catch(e => { console.error('\n❌ Import failed:', e.message); process.exit(1); });
