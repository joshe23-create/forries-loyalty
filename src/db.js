const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'loyalty.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                  -- shown as QR on the member's card
  name TEXT NOT NULL,
  email TEXT UNIQUE COLLATE NOCASE,
  phone TEXT UNIQUE,                          -- digits incl. country code, e.g. 27821234567
  birth_day INTEGER,
  birth_month INTEGER,
  marketing_email INTEGER NOT NULL DEFAULT 0, -- POPIA: explicit opt-in per channel
  marketing_whatsapp INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_visit_at TEXT
);

CREATE TABLE IF NOT EXISTS member_sessions (
  token TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_codes (
  member_id INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',         -- staff | admin
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS staff_sessions (
  token TEXT PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- A stamp card, e.g. "Coffee card: 9 stamps -> free coffee"
CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  stamps_required INTEGER NOT NULL,
  reward TEXT NOT NULL,
  reward_valid_days INTEGER NOT NULL DEFAULT 90,
  emoji TEXT NOT NULL DEFAULT '⭐',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS member_cards (
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  stamps INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, program_id)
);

CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source TEXT NOT NULL,                       -- stamps | birthday | gift
  program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
  birthday_year INTEGER,
  tx_id INTEGER,                              -- the stamp transaction that earned it (for undo)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  redeemed_at TEXT,
  redeemed_by INTEGER REFERENCES staff(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_birthday ON vouchers(member_id, birthday_year) WHERE source = 'birthday';

-- Audit trail of everything staff do to a member's account.
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  type TEXT NOT NULL,                         -- stamp | redeem | gift
  program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
  voucher_id INTEGER REFERENCES vouchers(id) ON DELETE SET NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  stamps_before INTEGER,
  undone INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_tx_member ON transactions(member_id, id);
CREATE INDEX IF NOT EXISTS ix_tx_time ON transactions(created_at);

CREATE TABLE IF NOT EXISTS specials (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  starts_on TEXT,                             -- YYYY-MM-DD, inclusive; null = now
  ends_on TEXT,                               -- YYYY-MM-DD, inclusive; null = no end
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,                      -- email | whatsapp
  subject TEXT,
  body TEXT,
  template TEXT,
  audience TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// Starter stamp cards on a fresh install (editable in the admin).
if (db.prepare('SELECT COUNT(*) n FROM programs').get().n === 0) {
  const ins = db.prepare('INSERT INTO programs (name, stamps_required, reward, emoji, sort) VALUES (?, ?, ?, ?, ?)');
  ins.run('Coffee card', 9, 'Free coffee of your choice', '☕', 1);
  ins.run('Pint card', 9, 'Free draught pint', '🍺', 2);
}

module.exports = db;
