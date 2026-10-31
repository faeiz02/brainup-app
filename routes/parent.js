// Portail parent : accès par lien à jeton aléatoire (hash en base, expirant, révocable), limité à UNE famille.
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { db } = require('../database/db');
const R = require('../lib/rules');
const router = express.Router();
router.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));
router.use((req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const t = authHeader.replace(/^Bearer\s+/i, '') || (req.query && req.query.token) || '';
  const row = t && db.prepare('SELECT * FROM parent_tokens WHERE token_hash=? AND revoked=0 AND expires_at>?').get(crypto.createHash('sha256').update(t).digest('hex'), new Date().toISOString());
  if (!row) return res.status(401).json({ error: 'Lien invalide ou expiré.' });
  req.familyId = row.family_id; next();
});
const run = fn => (req, res) => { try { fn(req, res); } catch (e) { if (e instanceof R.RuleError) return res.status(e.code).json({ error: e.message }); console.error(e); res.status(500).json({ error: 'Erreur serveur.' }); } };
const mine = (req, id) => db.prepare('SELECT * FROM enrollments WHERE id=? AND family_id=?').get(id, req.familyId);

router.get('/me', run((req, res) => {
  const fam = db.prepare('SELECT id,parent_name,phone,email,address FROM families WHERE id=?').get(req.familyId);
  const ens = db.prepare(`
    SELECT e.id,e.number,e.status,e.start_date,e.end_date,e.weekly_limit,e.modules,
           c.id child_id,c.prenom,c.nom
    FROM enrollments e
    JOIN children c ON c.id=e.child_id
    WHERE e.family_id=?
  `).all(req.familyId);
  res.json({ family: fam, enrollments: ens });
}));
router.get('/slots', run((req, res) => {
  const e = mine(req, req.query.enrollment_id); if (!e) return res.status(404).json({ error: 'Inscription introuvable.' });
  const mods = JSON.parse(e.modules || '[]'); if (!mods.length) return res.json([]);
  const rows = db.prepare(`SELECT s.id,s.date,s.time,s.module_id,m.title,s.capacity-(SELECT COUNT(*) FROM bookings b WHERE b.slot_id=s.id AND b.status!='cancelled') remaining
    FROM slots s JOIN modules m ON m.id=s.module_id WHERE s.active=1 AND s.module_id IN (${mods.map(() => '?').join(',')}) AND s.date BETWEEN ? AND ? AND s.date>=date('now') ORDER BY s.date,s.time`)
    .all(...mods, e.start_date, e.end_date);
  res.json(rows.filter(r => r.remaining > 0));
}));
router.get('/bookings', run((req, res) => {
  const rows = db.prepare(`
    SELECT b.id,b.status,b.child_id,s.date,s.time,m.title,c.prenom child_prenom,c.nom child_nom
    FROM bookings b
    JOIN enrollments e ON e.id=b.enrollment_id
    JOIN slots s ON s.id=b.slot_id
    JOIN modules m ON m.id=s.module_id
    JOIN children c ON c.id=b.child_id
    WHERE e.family_id=?
    ORDER BY s.date DESC, s.time DESC
  `).all(req.familyId);
  res.json(rows);
}));
router.post('/bookings', run((req, res) => {
  const { enrollment_id, slot_id } = req.body || {};
  if (!mine(req, enrollment_id)) return res.status(404).json({ error: 'Inscription introuvable.' });
  const id = R.bookSlot.immediate(enrollment_id, slot_id); R.audit(null, 'booking.create_parent', 'booking', id, { family: req.familyId }); res.status(201).json({ id });
}));
router.post('/bookings/:id/cancel', run((req, res) => {
  const b = db.prepare('SELECT b.id FROM bookings b JOIN enrollments e ON e.id=b.enrollment_id WHERE b.id=? AND e.family_id=?').get(req.params.id, req.familyId);
  if (!b) return res.status(404).json({ error: 'Réservation introuvable.' });
  const r = R.cancelBooking(b.id, 'parent'); R.audit(null, 'booking.cancel_parent', 'booking', b.id, r); res.json(r);
}));
module.exports = router;
