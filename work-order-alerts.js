/**
 * work-order-alerts.js — Connect Server Patch
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS ADDS TO crm-server.js:
 *
 *  1. DB migration runner (call in initDB)
 *  2. Alert classification engine (NOT_SCHEDULED / OVERDUE / ON_TRACK)
 *  3. Enhanced work order upload with rent roll cross-reference
 *  4. Person-level work order API for leads page
 *  5. Expanded performance dashboard stats API
 *  6. Automatic household grouping from rent roll
 *
 * HOW TO INTEGRATE:
 *  - require() this file in crm-server.js
 *  - Call initWorkOrderAlerts(pool) inside your initDB() chain
 *  - Call registerWorkOrderRoutes(app, pool, auth, broadcastToAll) after auth middleware setup
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const OVERDUE_HOURS = 6;
const OPEN_STATUSES  = ['New','Estimate Requested','Estimated','Assigned','Scheduled','Waiting','Work Done','Ready to Bill'];
const CLOSED_STATUSES = ['Completed','Completed No Need To Bill','Canceled','Cancelled'];

// ─── DB Migration ────────────────────────────────────────────────────────────
async function initWorkOrderAlerts(pool) {
  const run = async (sql, label) => {
    try { await pool.query(sql); }
    catch(e) { console.warn(`[WO Migration] ${label}:`, e.message); }
  };

  // Add missing columns to work_orders
  await run(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS scheduled_end TIMESTAMPTZ`, 'add scheduled_end');
  await run(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS work_done_on TIMESTAMPTZ`, 'add work_done_on');
  await run(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS issue TEXT`, 'add issue');
  await run(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS instructions TEXT`, 'add instructions');
  await run(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS recurring TEXT`, 'add recurring');
  await run(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS alert_state TEXT DEFAULT 'NONE'`, 'add alert_state');
  await run(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS person_id INTEGER REFERENCES people(id) ON DELETE SET NULL`, 'add wo person_id');
  await run(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS matched_tenants TEXT[]`, 'add matched_tenants');
  await run(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS is_household BOOLEAN DEFAULT FALSE`, 'add is_household');
  await run(`ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS days_open NUMERIC`, 'add days_open');

  // Add person_id to rent_roll
  await run(`ALTER TABLE rent_roll ADD COLUMN IF NOT EXISTS person_id INTEGER REFERENCES people(id) ON DELETE SET NULL`, 'add rr person_id');

  // Indexes
  await run(`CREATE INDEX IF NOT EXISTS idx_wo_alert_state ON work_orders(alert_state) WHERE alert_state NOT IN ('COMPLETED','NONE')`, 'idx alert_state');
  await run(`CREATE INDEX IF NOT EXISTS idx_wo_person_id ON work_orders(person_id) WHERE person_id IS NOT NULL`, 'idx wo person_id');
  await run(`CREATE INDEX IF NOT EXISTS idx_wo_property_unit ON work_orders(property, unit)`, 'idx wo prop_unit');
  await run(`CREATE INDEX IF NOT EXISTS idx_rr_person_id ON rent_roll(person_id) WHERE person_id IS NOT NULL`, 'idx rr person_id');

  console.log('[WO Alerts] ✅ Migration complete');
}

// ─── Alert Classification ────────────────────────────────────────────────────
function classifyAlert(wo) {
  if (CLOSED_STATUSES.includes(wo.status)) return 'COMPLETED';
  if (!OPEN_STATUSES.includes(wo.status)) return 'COMPLETED';

  // No scheduled end → NOT SCHEDULED
  if (!wo.scheduled_end) return 'NOT_SCHEDULED';

  const scheduledEnd = new Date(wo.scheduled_end);
  if (isNaN(scheduledEnd.getTime())) return 'NOT_SCHEDULED';

  const hoursPastDue = (Date.now() - scheduledEnd.getTime()) / (1000 * 60 * 60);
  if (hoursPastDue >= OVERDUE_HOURS) return 'OVERDUE';

  return 'ON_TRACK';
}

// ─── Name Matching ───────────────────────────────────────────────────────────
function normalizeName(n) {
  return (n || '').replace(/[^a-z]/gi, '').toLowerCase();
}

function namesMatch(rentRollName, woName) {
  if (!rentRollName || !woName) return false;
  const rr = normalizeName(rentRollName);
  const wo = normalizeName(woName);
  if (rr === wo) return true;
  // Try reversing "Last, First" → "FirstLast"
  const parts = woName.split(',').map(s => s.trim());
  if (parts.length === 2) {
    const reversed = normalizeName(parts[1] + parts[0]);
    if (reversed === rr) return true;
  }
  return false;
}

// Unit normalization: "Unit 115" / "APT 31" / "Villa Chateau Apartments: Unit 119" → "115" / "31" / "119"
function normalizeUnit(u) {
  if (!u) return '';
  return u.replace(/^(Unit|APT|Apt|#|Villa Chateau Apartments:\s*Unit)\s*/i, '').trim().toLowerCase();
}

// ─── Cross-Reference: Work Order → Rent Roll → Person ───────────────────────
async function crossReferenceWO(pool, wo) {
  // Step 1: Find rent roll tenants at this property + unit
  let tenantRows;
  if (wo.unit) {
    const normUnit = normalizeUnit(wo.unit);
    // Try exact match first, then normalized
    const { rows } = await pool.query(
      `SELECT id, property, unit, tenant_name, person_id
       FROM rent_roll
       WHERE property = $1 AND status = 'Current'
       AND (LOWER(TRIM(unit)) = $2 OR LOWER(TRIM(REGEXP_REPLACE(unit, '^(Unit|APT|Apt|#)\\s*', '', 'i'))) = $2)`,
      [wo.property, normUnit]
    );
    tenantRows = rows;
  } else {
    // Single-family home: match property, no unit (or unit is empty/generic)
    const { rows } = await pool.query(
      `SELECT id, property, unit, tenant_name, person_id
       FROM rent_roll
       WHERE property = $1 AND status = 'Current'
       AND (unit IS NULL OR unit = '' OR unit LIKE '%single%' OR unit = property)`,
      [wo.property]
    );
    // If still no match, try single-unit properties (only 1 unit at this property)
    if (!rows.length) {
      const { rows: singleRows } = await pool.query(
        `SELECT id, property, unit, tenant_name, person_id
         FROM rent_roll
         WHERE property = $1 AND status = 'Current'`,
        [wo.property]
      );
      if (singleRows.length === 1) tenantRows = singleRows;
      else tenantRows = [];
    } else {
      tenantRows = rows;
    }
  }

  if (!tenantRows.length) return { personId: null, matchedTenants: [], isHousehold: false };

  const matchedTenants = tenantRows.map(t => t.tenant_name);
  const isHousehold = tenantRows.length > 1;

  // Step 2: Find the primary match (matches the WO resident name)
  let primaryTenant = tenantRows[0]; // default to first
  if (wo.resident) {
    const nameMatch = tenantRows.find(t => namesMatch(t.tenant_name, wo.resident));
    if (nameMatch) primaryTenant = nameMatch;
  }

  // Step 3: Resolve to Connect person_id
  let personId = primaryTenant.person_id;
  if (!personId) {
    // Try to find person by name match
    personId = await findPersonByTenantName(pool, primaryTenant.tenant_name);
    // Cache it on the rent_roll row
    if (personId) {
      await pool.query('UPDATE rent_roll SET person_id = $1 WHERE id = $2', [personId, primaryTenant.id])
        .catch(() => {});
    }
  }

  return { personId, matchedTenants, isHousehold };
}

async function findPersonByTenantName(pool, tenantName) {
  if (!tenantName) return null;
  // Parse "FirstName LastName" or "FirstName M. LastName"
  const parts = tenantName.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const firstName = parts[0];
  const lastName = parts[parts.length - 1];

  try {
    const { rows } = await pool.query(
      `SELECT id FROM people
       WHERE LOWER(TRIM(first_name)) = LOWER($1)
         AND LOWER(TRIM(last_name)) = LOWER($2)
       LIMIT 1`,
      [firstName, lastName]
    );
    return rows[0]?.id || null;
  } catch(e) { return null; }
}

// ─── Household Auto-Grouping ─────────────────────────────────────────────────
async function autoGroupHouseholds(pool, broadcastFn) {
  try {
    // Find all rent_roll entries with person_ids at the same property+unit
    const { rows } = await pool.query(`
      SELECT property, unit, ARRAY_AGG(person_id) AS person_ids
      FROM rent_roll
      WHERE person_id IS NOT NULL AND status = 'Current'
      GROUP BY property, unit
      HAVING COUNT(DISTINCT person_id) > 1
    `);

    let created = 0;
    for (const group of rows) {
      const ids = group.person_ids.filter(Boolean);
      // Create pairwise relationships
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = Math.min(ids[i], ids[j]);
          const b = Math.max(ids[i], ids[j]);
          try {
            await pool.query(
              `INSERT INTO person_relationships (person_id_a, person_id_b, label)
               VALUES ($1, $2, 'household')
               ON CONFLICT (person_id_a, person_id_b) DO NOTHING`,
              [a, b]
            );
            created++;
          } catch(e) { /* duplicate, skip */ }
        }
      }
    }
    console.log(`[WO Alerts] ✅ Household auto-group: ${rows.length} units, ${created} relationships`);
    return { units: rows.length, relationships: created };
  } catch(e) {
    console.error('[WO Alerts] Household grouping error:', e.message);
    return { units: 0, relationships: 0 };
  }
}

// ─── Bulk Reclassify Alerts ──────────────────────────────────────────────────
async function reclassifyAllAlerts(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT id, status, scheduled_end, created_at FROM work_orders
       WHERE status NOT IN ('Completed','Completed No Need To Bill','Canceled','Cancelled')`
    );

    let overdue = 0, notScheduled = 0, onTrack = 0;
    for (const wo of rows) {
      const alert = classifyAlert(wo);
      const daysOpen = wo.created_at
        ? Math.max(0, (Date.now() - new Date(wo.created_at).getTime()) / (1000 * 60 * 60 * 24))
        : null;
      await pool.query(
        'UPDATE work_orders SET alert_state = $1, days_open = $2 WHERE id = $3',
        [alert, daysOpen ? Math.round(daysOpen * 10) / 10 : null, wo.id]
      );
      if (alert === 'OVERDUE') overdue++;
      else if (alert === 'NOT_SCHEDULED') notScheduled++;
      else if (alert === 'ON_TRACK') onTrack++;
    }

    // Mark all closed ones
    await pool.query(
      `UPDATE work_orders SET alert_state = 'COMPLETED'
       WHERE status IN ('Completed','Completed No Need To Bill','Canceled','Cancelled')
         AND alert_state != 'COMPLETED'`
    );

    console.log(`[WO Alerts] Reclassified: ${overdue} overdue, ${notScheduled} not scheduled, ${onTrack} on track`);
    return { overdue, notScheduled, onTrack };
  } catch(e) {
    console.error('[WO Alerts] Reclassify error:', e.message);
    return {};
  }
}

// ─── Route Registration ──────────────────────────────────────────────────────

function registerWorkOrderRoutes(app, pool, auth, broadcastToAll) {

  // ═══════════════════════════════════════════════════════════════════════════
  // ENHANCED WORK ORDER UPLOAD — replaces existing /api/work-orders/upload
  // Adds: scheduled_end, issue, alert classification, rent roll cross-reference
  // ═══════════════════════════════════════════════════════════════════════════
  app.post('/api/work-orders/upload-v2', auth, async (req, res) => {
    try {
      const { rows, filename } = req.body;
      if (!rows || !Array.isArray(rows) || rows.length === 0)
        return res.status(400).json({ error: 'No rows provided' });

      const batchId = require('crypto').randomUUID();
      let inserted = 0, skipped = 0, matched = 0, households = 0;

      for (const r of rows) {
        if (!r.wo_number && !r.job_description) { skipped++; continue; }

        // Classify alert state
        const woObj = {
          status: r.status || '',
          scheduled_end: r.scheduled_end ? new Date(r.scheduled_end) : null,
        };
        const alertState = classifyAlert(woObj);

        // Calculate days open
        const createdDate = r.created_at ? new Date(r.created_at) : null;
        const daysOpen = createdDate && !isNaN(createdDate.getTime())
          ? Math.round(((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)) * 10) / 10
          : null;

        // Cross-reference rent roll → person
        const xref = await crossReferenceWO(pool, {
          property: r.property || '',
          unit: r.unit || null,
          resident: r.resident || null,
        });
        if (xref.personId) matched++;
        if (xref.isHousehold) households++;

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
            [
              r.property||null, r.wo_number||null, r.priority||null, r.wo_type||null,
              r.job_description||null, r.instructions||null, r.status||null,
              r.vendor||null, r.unit||null, r.resident||null,
              r.created_at ? new Date(r.created_at) : null,
              r.scheduled_start ? new Date(r.scheduled_start) : null,
              r.scheduled_end ? new Date(r.scheduled_end) : null,
              r.work_done_on ? new Date(r.work_done_on) : null,
              r.completed_on ? new Date(r.completed_on) : null,
              r.amount ? parseFloat(r.amount) : null,
              r.issue||null, r.recurring||null, batchId,
              alertState, xref.personId, xref.matchedTenants.length ? xref.matchedTenants : null,
              xref.isHousehold, daysOpen,
            ]
          );
          inserted++;
        } catch(e) { console.warn('[WO Upload v2] skip:', e.message); skipped++; }
      }

      const uploader = req.agent?.name || req.agent?.id || null;
      await pool.query(
        `INSERT INTO work_order_uploads (filename,uploaded_by,record_count) VALUES ($1,$2,$3)`,
        [filename||'work_orders.xlsx', uploader, inserted]
      );

      // Auto-group households
      const hhResult = await autoGroupHouseholds(pool, broadcastToAll);

      // Broadcast update
      broadcastToAll({ type: 'work_orders_updated', inserted, matched, overdue: 0 });

      res.json({ ok: true, inserted, skipped, matched, households, batchId, householdGroups: hhResult });
    } catch(e) {
      console.error('[WO Upload v2]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ALERTS — for leads page work order module
  // ═══════════════════════════════════════════════════════════════════════════

  // Get open WO alerts for a specific person (by person_id)
  app.get('/api/work-orders/by-person/:personId', auth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT wo_number, property, unit, resident, status, vendor, issue,
                priority, alert_state, scheduled_start, scheduled_end, created_at,
                days_open, job_description, is_household, matched_tenants
         FROM work_orders
         WHERE person_id = $1
         ORDER BY
           CASE alert_state
             WHEN 'OVERDUE' THEN 1
             WHEN 'NOT_SCHEDULED' THEN 2
             WHEN 'ON_TRACK' THEN 3
             ELSE 4
           END,
           created_at DESC`,
        [req.params.personId]
      );
      // Also get via household (person_relationships)
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
           AND wo.alert_state NOT IN ('COMPLETED','NONE')
           AND wo.wo_number NOT IN (SELECT wo_number FROM work_orders WHERE person_id = $1)
         ORDER BY wo.created_at DESC`,
        [req.params.personId]
      );

      // Reclassify in real-time
      const allWOs = [...rows, ...hhRows].map(wo => ({
        ...wo,
        alert_state: classifyAlert(wo),
      }));

      const open = allWOs.filter(w => w.alert_state !== 'COMPLETED');
      const overdue = open.filter(w => w.alert_state === 'OVERDUE').length;
      const notScheduled = open.filter(w => w.alert_state === 'NOT_SCHEDULED').length;

      res.json({
        workOrders: allWOs,
        open: open.length,
        overdue,
        notScheduled,
        onTrack: open.length - overdue - notScheduled,
        hasHouseholdWOs: hhRows.length > 0,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Get all open alerts (for the work order dashboard control screen)
  app.get('/api/work-orders/alerts', auth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT wo_number, property, unit, resident, status, vendor, issue,
                priority, alert_state, scheduled_start, scheduled_end, created_at,
                days_open, person_id, is_household, matched_tenants
         FROM work_orders
         WHERE status NOT IN ('Completed','Completed No Need To Bill','Canceled','Cancelled')
         ORDER BY
           CASE
             WHEN scheduled_end IS NOT NULL AND scheduled_end + INTERVAL '${OVERDUE_HOURS} hours' < NOW() THEN 1
             WHEN scheduled_end IS NULL THEN 2
             ELSE 3
           END,
           created_at ASC`
      );

      // Real-time reclassification
      const alerts = rows.map(wo => ({
        ...wo,
        alert_state: classifyAlert(wo),
        days_open: wo.created_at
          ? Math.round(((Date.now() - new Date(wo.created_at).getTime()) / (1000*60*60*24)) * 10) / 10
          : null,
      }));

      const overdue = alerts.filter(a => a.alert_state === 'OVERDUE').length;
      const notScheduled = alerts.filter(a => a.alert_state === 'NOT_SCHEDULED').length;
      const onTrack = alerts.filter(a => a.alert_state === 'ON_TRACK').length;

      res.json({ alerts, summary: { total: alerts.length, overdue, notScheduled, onTrack } });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PERFORMANCE DASHBOARD — expanded stats
  // ═══════════════════════════════════════════════════════════════════════════
  app.get('/api/work-orders/performance', auth, async (req, res) => {
    try {
      // KPI totals
      const kpi = await pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status NOT IN ('Completed','Completed No Need To Bill','Canceled','Cancelled'))::int AS open,
          COUNT(*) FILTER (WHERE status IN ('Completed','Completed No Need To Bill'))::int AS completed,
          COUNT(*) FILTER (WHERE status = 'Canceled' OR status = 'Cancelled')::int AS canceled,
          ROUND(AVG(
            CASE WHEN completed_on IS NOT NULL AND created_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM (completed_on - created_at)) / 86400.0
            END
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
        const a = classifyAlert(wo);
        if (a === 'OVERDUE') overdue++;
        else if (a === 'NOT_SCHEDULED') notScheduled++;
        else if (a === 'ON_TRACK') onTrack++;
      }

      // Vendor ranking
      const vendors = await pool.query(`
        SELECT
          vendor,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status IN ('Completed','Completed No Need To Bill'))::int AS completed,
          COUNT(*) FILTER (WHERE status NOT IN ('Completed','Completed No Need To Bill','Canceled','Cancelled'))::int AS open,
          ROUND(AVG(
            CASE WHEN completed_on IS NOT NULL AND created_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM (completed_on - created_at)) / 86400.0
            END
          )::numeric, 1) AS avg_days_to_close,
          ROUND(SUM(COALESCE(amount,0))::numeric, 2) AS total_cost
        FROM work_orders
        WHERE vendor IS NOT NULL AND vendor != ''
        GROUP BY vendor
        ORDER BY COUNT(*) DESC
      `);

      // Property volume — current month vs 3-month rolling avg
      const propVolume = await pool.query(`
        WITH monthly AS (
          SELECT property,
                 DATE_TRUNC('month', created_at) AS month,
                 COUNT(*)::int AS cnt
          FROM work_orders
          WHERE created_at > NOW() - INTERVAL '6 months'
          GROUP BY property, DATE_TRUNC('month', created_at)
        )
        SELECT property,
               COALESCE(MAX(CASE WHEN month = DATE_TRUNC('month', NOW()) THEN cnt END), 0)::int AS this_month,
               ROUND(AVG(CASE WHEN month < DATE_TRUNC('month', NOW()) THEN cnt END)::numeric, 1) AS rolling_avg,
               CASE
                 WHEN AVG(CASE WHEN month < DATE_TRUNC('month', NOW()) THEN cnt END) > 0
                 THEN ROUND((
                   COALESCE(MAX(CASE WHEN month = DATE_TRUNC('month', NOW()) THEN cnt END), 0)
                   / AVG(CASE WHEN month < DATE_TRUNC('month', NOW()) THEN cnt END) - 1
                 ) * 100)::int
                 ELSE 0
               END AS delta_pct,
               COALESCE(MAX(CASE WHEN month = DATE_TRUNC('month', NOW()) THEN cnt END), 0)
                 > COALESCE(AVG(CASE WHEN month < DATE_TRUNC('month', NOW()) THEN cnt END), 999) AS exceeds_avg
        FROM monthly
        GROUP BY property
        HAVING COALESCE(MAX(CASE WHEN month = DATE_TRUNC('month', NOW()) THEN cnt END), 0)
             + COALESCE(MAX(CASE WHEN month = DATE_TRUNC('month', NOW() - INTERVAL '1 month') THEN cnt END), 0) > 0
        ORDER BY COALESCE(MAX(CASE WHEN month = DATE_TRUNC('month', NOW()) THEN cnt END), 0) DESC
        LIMIT 20
      `);

      // Issue type breakdown
      const issues = await pool.query(`
        SELECT COALESCE(issue, 'Unspecified') AS issue, COUNT(*)::int AS cnt
        FROM work_orders
        WHERE issue IS NOT NULL AND issue != ''
        GROUP BY issue
        ORDER BY COUNT(*) DESC
        LIMIT 15
      `);

      res.json({
        kpi: kpi.rows[0],
        alerts: { overdue, notScheduled, onTrack },
        vendors: vendors.rows,
        propertyVolume: propVolume.rows,
        issueBreakdown: issues.rows,
      });
    } catch(e) {
      console.error('[WO Performance]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // RECLASSIFY — run on demand or on a timer to update alert states
  // ═══════════════════════════════════════════════════════════════════════════
  app.post('/api/work-orders/reclassify', auth, async (req, res) => {
    try {
      const result = await reclassifyAllAlerts(pool);
      res.json({ ok: true, ...result });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTO-LINK — try to match all rent_roll entries to people
  // ═══════════════════════════════════════════════════════════════════════════
  app.post('/api/work-orders/auto-link', auth, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, tenant_name FROM rent_roll WHERE person_id IS NULL AND status = 'Current'`
      );
      let linked = 0;
      for (const rr of rows) {
        const personId = await findPersonByTenantName(pool, rr.tenant_name);
        if (personId) {
          await pool.query('UPDATE rent_roll SET person_id = $1 WHERE id = $2', [personId, rr.id]);
          linked++;
        }
      }
      // Also update work_orders that now have matching rent_roll entries
      await pool.query(`
        UPDATE work_orders wo SET person_id = rr.person_id
        FROM rent_roll rr
        WHERE wo.person_id IS NULL
          AND rr.person_id IS NOT NULL
          AND rr.property = wo.property
          AND rr.status = 'Current'
          AND (
            (wo.unit IS NOT NULL AND LOWER(TRIM(rr.unit)) = LOWER(TRIM(wo.unit)))
            OR (wo.unit IS NULL AND rr.unit IS NULL)
          )
      `);

      // Auto-group households
      const hh = await autoGroupHouseholds(pool, broadcastToAll);

      res.json({ ok: true, linked, households: hh });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  console.log('[WO Alerts] ✅ Routes registered');
}

// ─── Alert Poller — run every 30 min to reclassify time-sensitive alerts ─────
function startAlertPoller(pool, broadcastToAll) {
  setInterval(async () => {
    const result = await reclassifyAllAlerts(pool);
    if (result.overdue > 0) {
      broadcastToAll({ type: 'wo_alerts_updated', ...result });
    }
  }, 30 * 60 * 1000); // every 30 minutes

  // Initial run 30s after boot
  setTimeout(() => reclassifyAllAlerts(pool), 30000);
}

module.exports = {
  initWorkOrderAlerts,
  registerWorkOrderRoutes,
  startAlertPoller,
  classifyAlert,
  reclassifyAllAlerts,
  autoGroupHouseholds,
  crossReferenceWO,
};
