const express = require('express');
const { db } = require('../database/db');

const router = express.Router();

// GET /api/cities — villes actives
router.get('/cities', (req, res) => {
  const cities = db.prepare(`
    SELECT id, name, slug, is_new, address, maps_url
    FROM cities WHERE active = 1 ORDER BY sort_order ASC, name ASC
  `).all();
  res.json(cities);
});

// GET /api/cities/:slug/modules?ageGroup=7-12 — modules d'une ville
router.get('/cities/:slug/modules', (req, res) => {
  const city = db.prepare('SELECT * FROM cities WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!city) return res.status(404).json({ error: 'Ville introuvable.' });

  const { ageGroup } = req.query;
  let modules;
  if (ageGroup) {
    modules = db.prepare(`
      SELECT * FROM modules WHERE city_id = ? AND active = 1 AND age_group = ?
      ORDER BY sort_order ASC
    `).all(city.id, ageGroup);
  } else {
    modules = db.prepare(`
      SELECT * FROM modules WHERE city_id = ? AND active = 1 ORDER BY sort_order ASC
    `).all(city.id);
  }
  res.json({ city, modules });
});

// GET /api/modules/:id/slots?month=2026-09 — créneaux disponibles d'un module pour un mois
router.get('/modules/:id/slots', (req, res) => {
  const moduleRow = db.prepare('SELECT * FROM modules WHERE id = ? AND active = 1').get(req.params.id);
  if (!moduleRow) return res.status(404).json({ error: 'Module introuvable.' });

  const city = db.prepare('SELECT * FROM cities WHERE id = ?').get(moduleRow.city_id);

  const month = req.query.month; // "2026-09"
  let slots;
  if (month) {
    slots = db.prepare(`
      SELECT s.*, 
        (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND b.status != 'cancelled') as booked_count
      FROM slots s
      WHERE s.module_id = ? AND s.active = 1 AND s.date LIKE ?
      ORDER BY s.date ASC, s.time ASC
    `).all(req.params.id, `${month}%`);
  } else {
    slots = db.prepare(`
      SELECT s.*, 
        (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND b.status != 'cancelled') as booked_count
      FROM slots s
      WHERE s.module_id = ? AND s.active = 1 AND s.date >= date('now')
      ORDER BY s.date ASC, s.time ASC
    `).all(req.params.id);
  }

  const withAvailability = slots.map(s => ({
    ...s,
    remaining: Math.max(0, s.capacity - s.booked_count),
  })).filter(s => s.remaining > 0);

  res.json({ module: moduleRow, city, slots: withAvailability });
});

// POST /api/bookings — créer une réservation
router.post('/bookings', (req, res) => {
  const { slotId, prenom, nom, email, parent, phone } = req.body || {};

  if (!slotId || !prenom || !nom || !email || !parent) {
    return res.status(400).json({ error: 'Merci de remplir tous les champs obligatoires.' });
  }
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return res.status(400).json({ error: "L'adresse e-mail n'est pas valide." });
  }

  const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND active = 1').get(slotId);
  if (!slot) return res.status(404).json({ error: 'Créneau introuvable.' });

  const bookedCount = db.prepare(`
    SELECT COUNT(*) c FROM bookings WHERE slot_id = ? AND status != 'cancelled'
  `).get(slotId).c;

  if (bookedCount >= slot.capacity) {
    return res.status(409).json({ error: 'Ce créneau est complet.' });
  }

  const result = db.prepare(`
    INSERT INTO bookings (slot_id, prenom, nom, email, parent_name, phone)
    VALUES (?,?,?,?,?,?)
  `).run(slotId, prenom.trim(), nom.trim(), email.trim(), parent.trim(), (phone || '').trim());

  const moduleRow = db.prepare('SELECT * FROM modules WHERE id = ?').get(slot.module_id);
  const city = db.prepare('SELECT * FROM cities WHERE id = ?').get(moduleRow.city_id);

  res.status(201).json({
    booking: {
      id: result.lastInsertRowid,
      prenom, nom, email, parent, phone,
      slot, module: moduleRow, city,
    },
  });
});

// GET /api/rules — règlement intérieur
router.get('/rules', (req, res) => {
  const rules = db.prepare('SELECT icon, body FROM rules ORDER BY sort_order ASC').all();
  res.json(rules);
});

// GET /api/announcements — annonces actives
router.get('/announcements', (req, res) => {
  const announcements = db.prepare(`
    SELECT title, body FROM announcements WHERE active = 1 ORDER BY sort_order ASC
  `).all();
  res.json(announcements);
});

// GET /api/settings — réglages publics (nom du site, téléphone…)
router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

module.exports = router;
