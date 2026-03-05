-- OKCREAL Connect — Full Database Schema
-- Run once on new database, safe to re-run (IF NOT EXISTS everywhere)

-- ── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  email        VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role         VARCHAR(50)  DEFAULT 'agent', -- admin | agent
  avatar_color VARCHAR(7)   DEFAULT '#D97706',
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- ── People ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS people (
  id               SERIAL PRIMARY KEY,
  first_name       VARCHAR(100),
  last_name        VARCHAR(100),
  email            VARCHAR(255),
  phone            VARCHAR(30),
  stage            VARCHAR(100) DEFAULT 'Lead',
  source           VARCHAR(100),
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  background       TEXT,
  created_at       TIMESTAMPTZ  DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_people_phone    ON people(phone);
CREATE INDEX IF NOT EXISTS idx_people_stage    ON people(stage);
CREATE INDEX IF NOT EXISTS idx_people_updated  ON people(updated_at DESC);

-- ── Additional phones ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS people_phones (
  id         SERIAL PRIMARY KEY,
  person_id  INTEGER REFERENCES people(id) ON DELETE CASCADE,
  phone      VARCHAR(30),
  type       VARCHAR(20) DEFAULT 'mobile',
  is_primary BOOLEAN     DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_people_phones_person ON people_phones(person_id);
CREATE INDEX IF NOT EXISTS idx_people_phones_phone  ON people_phones(phone);

-- ── Additional emails ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS people_emails (
  id         SERIAL PRIMARY KEY,
  person_id  INTEGER REFERENCES people(id) ON DELETE CASCADE,
  email      VARCHAR(255),
  type       VARCHAR(20) DEFAULT 'personal',
  is_primary BOOLEAN     DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_people_emails_person ON people_emails(person_id);

-- ── Tags ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tags (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(150) UNIQUE NOT NULL,
  color      VARCHAR(7)   DEFAULT '#6B7280',
  created_at TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS people_tags (
  person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
  tag_id    INTEGER REFERENCES tags(id)   ON DELETE CASCADE,
  PRIMARY KEY (person_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_people_tags_person ON people_tags(person_id);
CREATE INDEX IF NOT EXISTS idx_people_tags_tag    ON people_tags(tag_id);

-- ── Custom fields ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custom_fields (
  id       SERIAL PRIMARY KEY,
  name     VARCHAR(100) UNIQUE NOT NULL,
  label    VARCHAR(100) NOT NULL,
  type     VARCHAR(50)  DEFAULT 'text',
  options  JSONB,
  position INTEGER      DEFAULT 0
);

CREATE TABLE IF NOT EXISTS people_custom_fields (
  person_id  INTEGER REFERENCES people(id) ON DELETE CASCADE,
  field_name VARCHAR(100) NOT NULL,
  value      TEXT,
  PRIMARY KEY (person_id, field_name)
);

-- ── Activities ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activities (
  id            SERIAL PRIMARY KEY,
  person_id     INTEGER REFERENCES people(id) ON DELETE CASCADE,
  type          VARCHAR(50) NOT NULL,
  body          TEXT,
  subject       VARCHAR(255),
  direction     VARCHAR(20),
  duration      INTEGER,
  recording_url TEXT,
  transcript    TEXT,
  twilio_sid    VARCHAR(100),
  from_number   VARCHAR(30),
  to_number     VARCHAR(30),
  status        VARCHAR(50),
  starred       BOOLEAN     DEFAULT false,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activities_person  ON activities(person_id);
CREATE INDEX IF NOT EXISTS idx_activities_type    ON activities(type);
CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at DESC);

-- ── Tasks ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id           SERIAL PRIMARY KEY,
  person_id    INTEGER REFERENCES people(id) ON DELETE CASCADE,
  title        VARCHAR(255) NOT NULL,
  type         VARCHAR(100) DEFAULT 'Follow Up',
  note         TEXT,
  assigned_to  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date     TIMESTAMPTZ,
  completed    BOOLEAN     DEFAULT false,
  completed_at TIMESTAMPTZ,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_due      ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_person   ON tasks(person_id);

-- ── Smart Lists ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smart_lists (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  filters    JSONB        NOT NULL DEFAULT '{}',
  position   INTEGER      DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ  DEFAULT NOW()
);

-- ── Seed tags ─────────────────────────────────────────────────────────────────
INSERT INTO tags (name, color) VALUES
  ('Initiate debt collection robot', '#7C3AED'),
  ('Grok Call In Progress',          '#2563EB'),
  ('Grok Call Completed',            '#16A34A'),
  ('Grok Call Failed',               '#DC2626'),
  ('rentcollectionhelpplease',       '#EA580C'),
  ('EVICTION ALERT',                 '#DC2626'),
  ('Grok Payment Committed',         '#16A34A'),
  ('Grok No Answer - Manual Follow Up', '#D97706'),
  ('Grok Pause',                     '#6B7280'),
  ('Grok Stop',                      '#6B7280'),
  ('Grok Call Now',                  '#7C3AED'),
  ('Escalate to Management',         '#DC2626'),
  ('Grok Attempt 1',                 '#93C5FD'),
  ('Grok Attempt 2',                 '#60A5FA'),
  ('Grok Attempt 3',                 '#3B82F6'),
  ('Grok Attempt 4',                 '#2563EB'),
  ('Grok Attempt 5',                 '#1D4ED8'),
  ('On Payment Plan',                '#16A34A'),
  ('Delinquent',                     '#DC2626')
ON CONFLICT (name) DO NOTHING;

-- ── Seed custom fields ────────────────────────────────────────────────────────
INSERT INTO custom_fields (name, label, type, position) VALUES
  ('customPastDueBalance',  'Past Due Balance',             'number', 1),
  ('customDebtPaymentDate', 'Debt Payment Commitment Date', 'date',   2)
ON CONFLICT (name) DO NOTHING;

-- ── Seed smart lists ──────────────────────────────────────────────────────────
INSERT INTO smart_lists (name, filters, position) VALUES
  ('Delinquent',        '{"stage":"Delinquent"}',                               1),
  ('On Payment Plan',   '{"tags":["On Payment Plan"]}',                         2),
  ('Needs Human',       '{"tags":["rentcollectionhelpplease"]}',                3),
  ('Eviction Alert',    '{"tags":["EVICTION ALERT"]}',                          4),
  ('Escalate to Mgmt',  '{"tags":["Escalate to Management"]}',                  5),
  ('Grok Completed',    '{"tags":["Grok Call Completed"]}',                     6),
  ('No Answer',         '{"tags":["Grok No Answer - Manual Follow Up"]}',       7),
  ('Payment Committed', '{"tags":["Grok Payment Committed"]}',                  8)
ON CONFLICT DO NOTHING;

-- ── Updated_at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_people_updated ON people;
CREATE TRIGGER trg_people_updated
  BEFORE UPDATE ON people
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
