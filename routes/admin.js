const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { db } = require('../database/db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// 1re couche : limite par IP (protège même si des identifiants différents sont essayés)
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives depuis cette adresse. Réessayez dans 15 minutes.' },
});

/* ---------- AUTH ---------- */

router.post('/login', loginRateLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip;
  const logAttempt = (success, reason) => {
    db.prepare('INSERT INTO login_log (username, ip, success, reason) VALUES (?,?,?,?)')
      .run(username || '(vide)', ip, success ? 1 : 0, reason);
  };

  if (!username || !password) {
    return res.status(400).json({ error: 'Identifiant et mot de passe requis.' });
  }

  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);

  // Réponse volontairement identique que l'utilisateur existe ou non (évite l'énumération de comptes)
  const genericError = 'Identifiants incorrects.';

  if (!user) {
    logAttempt(false, 'compte inconnu');
    return res.status(401).json({ error: genericError });
  }

  // 2e couche : verrouillage du compte après plusieurs échecs
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    logAttempt(false, 'compte verrouillé');
    return res.status(423).json({ error: `Compte temporairement verrouillé suite à plusieurs échecs. Réessayez dans ${minutesLeft} min.` });
  }

  const valid = bcrypt.compareSync(password, user.password_hash);

  if (!valid) {
    const attempts = (user.failed_attempts || 0) + 1;
    let lockedUntil = null;
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      lockedUntil = new Date(Date.now() + LOCK_DURATION_MS).toISOString();
    }
    db.prepare('UPDATE admin_users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .run(attempts, lockedUntil, user.id);

    logAttempt(false, lockedUntil ? 'mot de passe incorrect (compte désormais verrouillé)' : 'mot de passe incorrect');

    if (lockedUntil) {
      return res.status(423).json({ error: `Trop d'échecs. Compte verrouillé 15 minutes.` });
    }
    return res.status(401).json({ error: genericError });
  }

  // Connexion réussie : on réinitialise le compteur d'échecs
  db.prepare('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
  logAttempt(true, null);

  // On régénère l'identifiant de session pour éviter toute fixation de session
  req.session = null;
  req.session = { adminId: user.id, username: user.username };
  res.json({ ok: true, username: user.username, mustChangePassword: !!user.must_change_password });
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.adminId) return res.status(401).json({ error: 'Non authentifié.' });
  const user = db.prepare('SELECT username, must_change_password FROM admin_users WHERE id = ?').get(req.session.adminId);
  if (!user) return res.status(401).json({ error: 'Non authentifié.' });
  res.json({ username: user.username, mustChangePassword: !!user.must_change_password });
});

router.post('/change-password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Mot de passe actuel et nouveau mot de passe requis.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' });
  }
  if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins une lettre et un chiffre.' });
  }
  const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.session.adminId);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
  }
  if (bcrypt.compareSync(newPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit être différent de l\'ancien.' });
  }
  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE admin_users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, user.id);
  res.json({ ok: true });
});

router.get('/login-log', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM login_log ORDER BY created_at DESC LIMIT 50').all();
  res.json(rows);
});

/* Toutes les routes ci-dessous nécessitent une session admin */
router.use(requireAdmin);

// Tant que le mot de passe n'a pas été changé après création du compte,
// on bloque tout le reste de l'API admin (sauf /me et /change-password déjà passées ci-dessus).
router.use((req, res, next) => {
  const user = db.prepare('SELECT must_change_password FROM admin_users WHERE id = ?').get(req.session.adminId);
  if (user && user.must_change_password) {
    return res.status(403).json({ error: 'PASSWORD_CHANGE_REQUIRED', message: 'Vous devez changer votre mot de passe avant de continuer.' });
  }
  next();
});

/* ---------- DASHBOARD ---------- */

router.get('/stats', (req, res) => {
  const totalBookings = db.prepare(`SELECT COUNT(*) c FROM bookings WHERE status != 'cancelled'`).get().c;
  const totalCities = db.prepare(`SELECT COUNT(*) c FROM cities WHERE active = 1`).get().c;
  const totalModules = db.prepare(`SELECT COUNT(*) c FROM modules WHERE active = 1`).get().c;
  const upcomingSlots = db.prepare(`SELECT COUNT(*) c FROM slots WHERE active = 1 AND date >= date('now')`).get().c;
  const bookingsThisWeek = db.prepare(`
    SELECT COUNT(*) c FROM bookings
    WHERE status != 'cancelled' AND created_at >= datetime('now', '-7 days')
  `).get().c;
  const nextBookings = db.prepare(`
    SELECT b.id, b.prenom, b.nom, b.status, s.date, s.time, m.title as module_title, c.name as city_name
    FROM bookings b
    JOIN slots s ON s.id = b.slot_id
    JOIN modules m ON m.id = s.module_id
    JOIN cities c ON c.id = m.city_id
    WHERE b.status != 'cancelled' AND s.date >= date('now')
    ORDER BY s.date ASC, s.time ASC
    LIMIT 8
  `).all();
  res.json({ totalBookings, totalCities, totalModules, upcomingSlots, bookingsThisWeek, nextBookings });
});

/* ---------- CITIES ---------- */

router.get('/cities', (req, res) => {
  res.json(db.prepare('SELECT * FROM cities ORDER BY sort_order ASC, name ASC').all());
});

router.post('/cities', (req, res) => {
  const { name, slug, address, maps_url, is_new, active, sort_order } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: 'Nom et identifiant (slug) requis.' });
  try {
    const result = db.prepare(`
      INSERT INTO cities (name, slug, address, maps_url, is_new, active, sort_order)
      VALUES (?,?,?,?,?,?,?)
    `).run(name, slug, address || '', maps_url || '', is_new ? 1 : 0, active === false ? 0 : 1, sort_order || 0);
    res.status(201).json(db.prepare('SELECT * FROM cities WHERE id = ?').get(result.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Cet identifiant de ville existe déjà.' : e.message });
  }
});

router.put('/cities/:id', (req, res) => {
  const { name, slug, address, maps_url, is_new, active, sort_order } = req.body || {};
  const existing = db.prepare('SELECT * FROM cities WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Ville introuvable.' });
  try {
    db.prepare(`
      UPDATE cities SET name=?, slug=?, address=?, maps_url=?, is_new=?, active=?, sort_order=?
      WHERE id=?
    `).run(
      name ?? existing.name, slug ?? existing.slug, address ?? existing.address,
      maps_url ?? existing.maps_url, is_new !== undefined ? (is_new ? 1 : 0) : existing.is_new,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      sort_order !== undefined ? sort_order : existing.sort_order,
      req.params.id
    );
    res.json(db.prepare('SELECT * FROM cities WHERE id = ?').get(req.params.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/cities/:id', (req, res) => {
  db.prepare('DELETE FROM cities WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------- MODULES ---------- */

router.get('/modules', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, c.name as city_name
    FROM modules m JOIN cities c ON c.id = m.city_id
    ORDER BY c.name ASC, m.sort_order ASC
  `).all();
  res.json(rows);
});

router.post('/modules', (req, res) => {
  const { city_id, title, description, icon, age_group, day_label, duration_minutes, active, sort_order } = req.body || {};
  if (!city_id || !title) return res.status(400).json({ error: 'Ville et titre requis.' });
  const result = db.prepare(`
    INSERT INTO modules (city_id, title, description, icon, age_group, day_label, duration_minutes, active, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(city_id, title, description || '', icon || 'robot', age_group || '7-12', day_label || '', duration_minutes || 90, active === false ? 0 : 1, sort_order || 0);
  res.status(201).json(db.prepare('SELECT * FROM modules WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/modules/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM modules WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Module introuvable.' });
  const b = req.body || {};
  db.prepare(`
    UPDATE modules SET city_id=?, title=?, description=?, icon=?, age_group=?, day_label=?, duration_minutes=?, active=?, sort_order=?
    WHERE id=?
  `).run(
    b.city_id ?? existing.city_id, b.title ?? existing.title, b.description ?? existing.description,
    b.icon ?? existing.icon, b.age_group ?? existing.age_group, b.day_label ?? existing.day_label,
    b.duration_minutes ?? existing.duration_minutes,
    b.active !== undefined ? (b.active ? 1 : 0) : existing.active,
    b.sort_order !== undefined ? b.sort_order : existing.sort_order,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM modules WHERE id = ?').get(req.params.id));
});

router.delete('/modules/:id', (req, res) => {
  db.prepare('DELETE FROM modules WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------- SLOTS ---------- */

router.get('/slots', (req, res) => {
  const { module_id } = req.query;
  let rows;
  if (module_id) {
    rows = db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND b.status != 'cancelled') as booked_count
      FROM slots s WHERE s.module_id = ? ORDER BY s.date ASC, s.time ASC
    `).all(module_id);
  } else {
    rows = db.prepare(`
      SELECT s.*, m.title as module_title, c.name as city_name,
        (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND b.status != 'cancelled') as booked_count
      FROM slots s
      JOIN modules m ON m.id = s.module_id
      JOIN cities c ON c.id = m.city_id
      ORDER BY s.date ASC, s.time ASC
    `).all();
  }
  res.json(rows);
});

router.post('/slots', (req, res) => {
  const { module_id, date, time, capacity } = req.body || {};
  if (!module_id || !date || !time) return res.status(400).json({ error: 'Module, date et heure requis.' });
  try {
    const result = db.prepare(`
      INSERT INTO slots (module_id, date, time, capacity) VALUES (?,?,?,?)
    `).run(module_id, date, time, capacity || 20);
    res.status(201).json(db.prepare('SELECT * FROM slots WHERE id = ?').get(result.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Ce créneau existe déjà pour ce module.' : e.message });
  }
});

// Génération en masse de créneaux récurrents (ex: chaque dimanche du mois à 15:30)
router.post('/slots/bulk', (req, res) => {
  const { module_id, weekday, time, capacity, start_date, end_date } = req.body || {};
  if (module_id === undefined || weekday === undefined || !time || !start_date || !end_date) {
    return res.status(400).json({ error: 'Champs manquants pour la génération en masse.' });
  }
  const start = new Date(start_date);
  const end = new Date(end_date);
  const insert = db.prepare(`INSERT OR IGNORE INTO slots (module_id, date, time, capacity) VALUES (?,?,?,?)`);
  let created = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === Number(weekday)) {
      const dateStr = d.toISOString().slice(0, 10);
      const info = insert.run(module_id, dateStr, time, capacity || 20);
      if (info.changes) created++;
    }
  }
  res.json({ ok: true, created });
});

router.put('/slots/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM slots WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Créneau introuvable.' });
  const b = req.body || {};
  db.prepare(`UPDATE slots SET date=?, time=?, capacity=?, active=? WHERE id=?`).run(
    b.date ?? existing.date, b.time ?? existing.time, b.capacity ?? existing.capacity,
    b.active !== undefined ? (b.active ? 1 : 0) : existing.active,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM slots WHERE id = ?').get(req.params.id));
});

router.delete('/slots/:id', (req, res) => {
  db.prepare('DELETE FROM slots WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------- BOOKINGS ---------- */

router.get('/bookings', (req, res) => {
  const { status, city_id, module_id, from, to, q } = req.query;
  let sql = `
    SELECT b.*, s.date, s.time, m.title as module_title, m.id as module_id, c.name as city_name, c.id as city_id
    FROM bookings b
    JOIN slots s ON s.id = b.slot_id
    JOIN modules m ON m.id = s.module_id
    JOIN cities c ON c.id = m.city_id
    WHERE 1=1
  `;
  const params = [];
  if (status) { sql += ' AND b.status = ?'; params.push(status); }
  if (city_id) { sql += ' AND c.id = ?'; params.push(city_id); }
  if (module_id) { sql += ' AND m.id = ?'; params.push(module_id); }
  if (from) { sql += ' AND s.date >= ?'; params.push(from); }
  if (to) { sql += ' AND s.date <= ?'; params.push(to); }
  if (q) {
    sql += ' AND (b.prenom LIKE ? OR b.nom LIKE ? OR b.email LIKE ? OR b.parent_name LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  sql += ' ORDER BY s.date DESC, s.time DESC';
  res.json(db.prepare(sql).all(...params));
});

router.patch('/bookings/:id', (req, res) => {
  const { status } = req.body || {};
  const valid = ['confirmed', 'cancelled', 'attended', 'absent'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Statut invalide.' });
  const existing = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Réservation introuvable.' });
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id));
});

router.delete('/bookings/:id', (req, res) => {
  db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/bookings-export.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT b.id, b.prenom, b.nom, b.email, b.parent_name, b.phone, b.status, b.created_at,
           s.date, s.time, m.title as module_title, c.name as city_name
    FROM bookings b
    JOIN slots s ON s.id = b.slot_id
    JOIN modules m ON m.id = s.module_id
    JOIN cities c ON c.id = m.city_id
    ORDER BY s.date DESC, s.time DESC
  `).all();
  const header = 'ID,Prenom,Nom,Email,Parent,Telephone,Statut,Cree_le,Date,Heure,Module,Ville\n';
  const csv = rows.map(r => [
    r.id, r.prenom, r.nom, r.email, r.parent_name, r.phone, r.status, r.created_at, r.date, r.time, r.module_title, r.city_name
  ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reservations.csv"');
  res.send(header + csv);
});

/* ---------- ANNOUNCEMENTS ---------- */

router.get('/announcements', (req, res) => {
  res.json(db.prepare('SELECT * FROM announcements ORDER BY sort_order ASC').all());
});

router.post('/announcements', (req, res) => {
  const { title, body, active, sort_order } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'Titre et texte requis.' });
  const result = db.prepare(`INSERT INTO announcements (title, body, active, sort_order) VALUES (?,?,?,?)`)
    .run(title, body, active === false ? 0 : 1, sort_order || 0);
  res.status(201).json(db.prepare('SELECT * FROM announcements WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/announcements/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Annonce introuvable.' });
  const b = req.body || {};
  db.prepare(`UPDATE announcements SET title=?, body=?, active=?, sort_order=? WHERE id=?`).run(
    b.title ?? existing.title, b.body ?? existing.body,
    b.active !== undefined ? (b.active ? 1 : 0) : existing.active,
    b.sort_order !== undefined ? b.sort_order : existing.sort_order,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id));
});

router.delete('/announcements/:id', (req, res) => {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------- RULES ---------- */

router.get('/rules', (req, res) => {
  res.json(db.prepare('SELECT * FROM rules ORDER BY sort_order ASC').all());
});

router.post('/rules', (req, res) => {
  const { icon, body, sort_order } = req.body || {};
  if (!body) return res.status(400).json({ error: 'Texte requis.' });
  const result = db.prepare(`INSERT INTO rules (icon, body, sort_order) VALUES (?,?,?)`)
    .run(icon || 'book', body, sort_order || 0);
  res.status(201).json(db.prepare('SELECT * FROM rules WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/rules/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM rules WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Règle introuvable.' });
  const b = req.body || {};
  db.prepare(`UPDATE rules SET icon=?, body=?, sort_order=? WHERE id=?`).run(
    b.icon ?? existing.icon, b.body ?? existing.body,
    b.sort_order !== undefined ? b.sort_order : existing.sort_order,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM rules WHERE id = ?').get(req.params.id));
});

router.delete('/rules/:id', (req, res) => {
  db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------- SETTINGS ---------- */

router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

router.put('/settings', (req, res) => {
  const entries = Object.entries(req.body || {});
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const tx = db.transaction((items) => {
    items.forEach(([k, v]) => upsert.run(k, String(v)));
  });
  tx(entries);
  res.json({ ok: true });
});

module.exports = router;
