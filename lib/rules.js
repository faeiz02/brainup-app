const crypto = require('crypto');
const { db } = require('../database/db');

class RuleError extends Error { constructor(m, code = 409) { super(m); this.code = code; } }
const setting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : d; };
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const addMonths = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const normPhone = p => { let d = String(p || '').replace(/\D/g, ''); if (d.length === 11 && d.startsWith('216')) d = d.slice(3); return d; };
// Semaine calendaire (lundi → dimanche). À confirmer avec le client (§9.3).
function weekRange(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z'); const s = new Date(d); s.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const e = new Date(s); e.setUTCDate(s.getUTCDate() + 6); return [s.toISOString().slice(0, 10), e.toISOString().slice(0, 10)];
}
function audit(userId, action, entity, entityId, details) {
  db.prepare('INSERT INTO audit_log (user_id,action,entity,entity_id,details) VALUES (?,?,?,?,?)')
    .run(userId || null, action, entity || null, entityId || null, details ? JSON.stringify(details) : null);
}
function balance(enrollmentId) {
  const en = db.prepare('SELECT total_amount FROM enrollments WHERE id=?').get(enrollmentId);
  const paid = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE enrollment_id=? AND status='enregistre'").get(enrollmentId).s;
  const remaining = en.total_amount - paid;
  return { total: en.total_amount, paid, remaining: Math.max(0, remaining), overpaid: Math.max(0, -remaining),
    status: paid <= 0 ? 'non_paye' : remaining > 0 ? 'partiellement_paye' : 'paye' };
}

// Toutes les règles §9.3 exécutées côté serveur, dans une transaction (anti double-réservation).
const bookSlot = db.transaction((enrollmentId, slotId) => {
  const en = db.prepare('SELECT * FROM enrollments WHERE id=?').get(enrollmentId);
  if (!en) throw new RuleError('Inscription introuvable.', 404);
  if (en.status !== 'active') throw new RuleError("L'inscription n'est pas active.", 403);
  const slot = db.prepare('SELECT s.*, m.duration_minutes dur FROM slots s JOIN modules m ON m.id=s.module_id WHERE s.id=? AND s.active=1').get(slotId);
  if (!slot) throw new RuleError('Créneau introuvable.', 404);
  if (slot.date < en.start_date || slot.date > en.end_date) throw new RuleError("Séance hors de la période de validité de l'inscription.", 403);
  if (!JSON.parse(en.modules || '[]').includes(slot.module_id)) throw new RuleError("Ce module n'est pas inclus dans l'inscription.", 403);
  const minH = Number(setting('min_booking_hours', '2'));
  if ((new Date(`${slot.date}T${slot.time}:00`) - Date.now()) / 36e5 < minH) throw new RuleError(`Réservation possible au moins ${minH} h avant la séance.`);
  const [ws, we] = weekRange(slot.date);
  const weekCount = db.prepare("SELECT COUNT(*) c FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE b.child_id=? AND b.status!='cancelled' AND s.date BETWEEN ? AND ?").get(en.child_id, ws, we).c;
  if (weekCount >= en.weekly_limit) throw new RuleError(`Limite de ${en.weekly_limit} séances par semaine atteinte.`);
  const same = db.prepare("SELECT s.time, m.duration_minutes dur FROM bookings b JOIN slots s ON s.id=b.slot_id JOIN modules m ON m.id=s.module_id WHERE b.child_id=? AND b.status!='cancelled' AND s.date=?").all(en.child_id, slot.date);
  const a0 = toMin(slot.time), a1 = a0 + slot.dur;
  if (same.some(o => a0 < toMin(o.time) + o.dur && toMin(o.time) < a1)) throw new RuleError('Cet enfant a déjà une séance qui chevauche ce créneau.');
  const booked = db.prepare("SELECT COUNT(*) c FROM bookings WHERE slot_id=? AND status!='cancelled'").get(slotId).c;
  if (booked >= slot.capacity) throw new RuleError('Ce créneau est complet.');
  const ch = db.prepare('SELECT * FROM children WHERE id=?').get(en.child_id);
  const fam = db.prepare('SELECT * FROM families WHERE id=?').get(en.family_id);
  const r = db.prepare('INSERT INTO bookings (slot_id,prenom,nom,email,parent_name,phone,enrollment_id,child_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(slotId, ch.prenom, ch.nom, fam.email || '', fam.parent_name, fam.phone, en.id, ch.id);
  return r.lastInsertRowid;
});

function cancelBooking(id, by) {
  const b = db.prepare('SELECT b.*, s.date, s.time FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE b.id=?').get(id);
  if (!b) throw new RuleError('Réservation introuvable.', 404);
  if (b.status !== 'confirmed') throw new RuleError('Cette réservation ne peut plus être annulée.');
  const hours = (new Date(`${b.date}T${b.time}:00`) - Date.now()) / 36e5;
  const late = by === 'parent' && hours < Number(setting('cancel_deadline_hours', '5'));
  // Annulation tardive = absence (règlement) ; annulation du centre ou dans les délais = place libérée.
  db.prepare("UPDATE bookings SET status=?, cancelled_by=?, cancelled_at=datetime('now') WHERE id=?")
    .run(late ? 'absent' : 'cancelled', by, id);
  return { status: late ? 'absent' : 'cancelled', late };
}

function issueParentToken(familyId, days = 90) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO parent_tokens (family_id,token_hash,expires_at) VALUES (?,?,?)')
    .run(familyId, crypto.createHash('sha256').update(token).digest('hex'), new Date(Date.now() + days * 864e5).toISOString());
  return token;
}
module.exports = { RuleError, setting, addMonths, normPhone, weekRange, audit, balance, bookSlot, cancelBooking, issueParentToken };
