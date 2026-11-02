// Extension du schéma selon le cahier des charges v1.0 (migration idempotente)
module.exports = function (db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS families (
    id INTEGER PRIMARY KEY AUTOINCREMENT, parent_name TEXT NOT NULL, phone TEXT NOT NULL,
    email TEXT DEFAULT '', address TEXT DEFAULT '', cin TEXT, source TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS idx_families_phone ON families(phone);
  CREATE TABLE IF NOT EXISTS children (
    id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER NOT NULL REFERENCES families(id),
    prenom TEXT NOT NULL, nom TEXT NOT NULL, birth_date TEXT, interests TEXT DEFAULT '',
    level TEXT DEFAULT '', notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS prospects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER REFERENCES families(id),
    name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT DEFAULT '', source TEXT NOT NULL,
    status TEXT DEFAULT 'a_appeler', next_follow_up TEXT, assigned_to INTEGER, notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS idx_prospects_phone ON prospects(phone);
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, prospect_id INTEGER REFERENCES prospects(id),
    type TEXT DEFAULT 'rappel', due_at TEXT NOT NULL, assignee INTEGER, status TEXT DEFAULT 'todo',
    note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, prospect_id INTEGER REFERENCES prospects(id),
    date_time TEXT NOT NULL, duration_minutes INTEGER DEFAULT 30, type TEXT DEFAULT 'decouverte',
    status TEXT DEFAULT 'a_confirmer', attendance TEXT DEFAULT 'non_renseignee', result TEXT,
    notes TEXT DEFAULT '', responsible INTEGER, rescheduled_from INTEGER REFERENCES appointments(id),
    created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS enrollments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT UNIQUE, child_id INTEGER NOT NULL REFERENCES children(id),
    family_id INTEGER NOT NULL REFERENCES families(id), plan_months INTEGER NOT NULL,
    start_date TEXT NOT NULL, end_date TEXT NOT NULL, modules TEXT NOT NULL DEFAULT '[]',
    weekly_limit INTEGER NOT NULL DEFAULT 3, total_amount REAL NOT NULL DEFAULT 0 CHECK(total_amount>=0),
    status TEXT DEFAULT 'en_attente', created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE, enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
    paid_at TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>0), method TEXT DEFAULT 'especes',
    external_ref TEXT DEFAULT '', status TEXT DEFAULT 'enregistre', cancel_reason TEXT,
    user_id INTEGER, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS parent_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER NOT NULL REFERENCES families(id),
    token_hash TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT NOT NULL, entity TEXT,
    entity_id INTEGER, details TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS prospect_children (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
    prenom TEXT NOT NULL,
    nom TEXT NOT NULL,
    age INTEGER,
    level TEXT DEFAULT '',
    interests TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS prospect_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    user_id INTEGER,
    called_at TEXT DEFAULT (datetime('now')),
    result TEXT NOT NULL,
    is_unanswered INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')));
  `);
  const addCol = (t, c, def) => {
    if (!db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
  };
  addCol('prospects', 'lost_reason', 'TEXT');
  addCol('prospects', 'lost_comment', 'TEXT');
  addCol('admin_users', 'role', "TEXT DEFAULT 'admin'");   // admin | accueil | compta | coach
  addCol('slots', 'coach_id', 'INTEGER');
  addCol('bookings', 'enrollment_id', 'INTEGER');
  addCol('bookings', 'child_id', 'INTEGER');
  addCol('bookings', 'cancelled_by', 'TEXT');
  addCol('bookings', 'cancelled_at', 'TEXT');
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
  [['weekly_limit', '3'], ['cancel_deadline_hours', '5'], ['min_booking_hours', '2'],
   ['public_booking_open', '1']].forEach(([k, v]) => ins.run(k, v));
};
