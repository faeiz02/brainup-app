const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../database/db');
const R = require('../lib/rules');
const router = express.Router();
const year = () => new Date().getFullYear();
const wrap = fn => (req, res) => {
  try { fn(req, res); } catch (e) {
    if (e instanceof R.RuleError) return res.status(e.code).json({ error: e.message });
    if (String(e.message).includes('CHECK') || String(e.message).includes('UNIQUE')) return res.status(400).json({ error: 'Données invalides ou déjà existantes.' });
    console.error(e); res.status(500).json({ error: 'Erreur serveur.' });
  }
};
const mask = c => (c ? '••••' + String(c).slice(-3) : null);
const need = (res, b, fields) => { const m = fields.filter(f => b[f] === undefined || b[f] === ''); if (m.length) { res.status(400).json({ error: 'Champs requis : ' + m.join(', ') }); return false; } return true; };

/* ---- Utilisateurs & rôles (admin) ---- */
router.get('/users', wrap((req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Réservé à l\'administrateur.' });
  res.json(db.prepare('SELECT id, username, role, must_change_password, created_at FROM admin_users ORDER BY id ASC').all());
}));
router.delete('/users/:id', wrap((req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Réservé à l\'administrateur.' });
  if (Number(req.params.id) === req.userId) return res.status(400).json({ error: 'Impossible de supprimer votre propre compte.' });
  db.prepare('DELETE FROM admin_users WHERE id=?').run(req.params.id);
  R.audit(req.userId, 'user.delete', 'user', Number(req.params.id));
  res.json({ ok: true });
}));
router.get('/coaches', wrap((req, res) => {
  res.json(db.prepare("SELECT id, username FROM admin_users WHERE role IN ('coach', 'admin') ORDER BY username ASC").all());
}));
router.post('/users', wrap((req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Réservé à l\'administrateur.' });
  const { username, password, role } = req.body || {};
  if (!username || !password || !['admin', 'accueil', 'compta', 'coach'].includes(role)) return res.status(400).json({ error: 'username, password et rôle valide requis.' });
  const r = db.prepare('INSERT INTO admin_users (username,password_hash,role,must_change_password) VALUES (?,?,?,1)').run(username, bcrypt.hashSync(password, 12), role);
  R.audit(req.userId, 'user.create', 'user', r.lastInsertRowid, { role });
  res.status(201).json({ id: r.lastInsertRowid, username, role });
}));

/* ---- CRM : prospects, doublons, tâches ---- */
const ALLOWED_STATUSES = ['a_appeler', 'contacte', 'interesse', 'a_relancer', 'converti', 'perdu', 'injoignable'];
const ALLOWED_LOST_REASONS = [
  'Prix trop élevé',
  'Distance / localisation',
  'Horaires incompatibles',
  'Enfant non intéressé',
  'Parent ayant choisi un autre centre',
  'Projet abandonné',
  'Autre'
];

router.get('/prospects', wrap((req, res) => {
  const { q, status, phone } = req.query; let sql = 'SELECT * FROM prospects WHERE 1=1'; const p = [];
  if (status) { sql += ' AND status=?'; p.push(status); }
  if (phone) { sql += ' AND phone=?'; p.push(R.normPhone(phone)); }
  if (q) { sql += ' AND (name LIKE ? OR phone LIKE ?)'; p.push(`%${q}%`, `%${q}%`); }
  const rows = db.prepare(sql + ' ORDER BY created_at DESC LIMIT 200').all(...p);
  res.json(rows.map(r => ({
    ...r,
    unanswered_calls: db.prepare('SELECT COUNT(*) c FROM prospect_calls WHERE prospect_id=? AND is_unanswered=1').get(r.id).c,
    children_count: db.prepare('SELECT COUNT(*) c FROM prospect_children WHERE prospect_id=?').get(r.id).c,
  })));
}));

router.delete('/prospects/:id', wrap((req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Réservé à l\'administrateur.' });
  const p = db.prepare('SELECT * FROM prospects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Prospect introuvable.' });

  // Règle CDC §1.1 : empêcher une suppression qui ferait perdre l'historique
  const appCount = db.prepare('SELECT COUNT(*) c FROM appointments WHERE prospect_id=?').get(p.id).c;
  const callsCount = db.prepare('SELECT COUNT(*) c FROM prospect_calls WHERE prospect_id=?').get(p.id).c;
  const taskCount = db.prepare('SELECT COUNT(*) c FROM tasks WHERE prospect_id=?').get(p.id).c;
  const hasFamily = !!p.family_id;

  if (appCount > 0 || callsCount > 0 || taskCount > 0 || hasFamily) {
    return res.status(400).json({
      error: 'Impossible de supprimer ce prospect car il possède des rendez-vous ou des données liées dans l\'historique. Pour préserver l\'historique commercial, veuillez plutôt le classer en « Perdu » ou « Injoignable ».'
    });
  }

  db.prepare('DELETE FROM prospect_children WHERE prospect_id=?').run(p.id);
  db.prepare('DELETE FROM prospects WHERE id=?').run(p.id);
  R.audit(req.userId, 'prospect.delete', 'prospect', p.id);
  res.json({ ok: true });
}));

router.post('/prospects', wrap((req, res) => {
  const b = req.body || {}; if (!need(res, b, ['name', 'phone', 'source'])) return;
  const phone = R.normPhone(b.phone);
  const dups = db.prepare('SELECT id,name,phone,status FROM prospects WHERE phone=?').all(phone);
  if (dups.length && !b.force) return res.status(409).json({ error: 'Un prospect avec ce téléphone existe déjà.', duplicates: dups });

  const status = b.status || 'a_appeler';
  if (!ALLOWED_STATUSES.includes(status)) return res.status(400).json({ error: 'Statut commercial invalide.' });

  if (status === 'perdu') {
    if (!b.lost_reason || !ALLOWED_LOST_REASONS.includes(b.lost_reason)) {
      return res.status(400).json({ error: 'La raison de la perte est obligatoire lorsque le statut est « Perdu ».' });
    }
    if (b.lost_reason === 'Autre' && !b.lost_comment?.trim()) {
      return res.status(400).json({ error: 'Un commentaire explicatif est obligatoire lorsque la raison est « Autre ».' });
    }
  }

  const r = db.prepare(`
    INSERT INTO prospects (name,phone,email,source,status,lost_reason,lost_comment,notes,assigned_to,next_follow_up)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    b.name, phone, b.email || '', b.source, status,
    status === 'perdu' ? b.lost_reason : null,
    (status === 'perdu' && b.lost_reason === 'Autre') ? b.lost_comment.trim() : (b.lost_comment || null),
    b.notes || '', req.userId, b.next_follow_up || null
  );

  R.audit(req.userId, 'prospect.create', 'prospect', r.lastInsertRowid, { status });
  res.status(201).json(db.prepare('SELECT * FROM prospects WHERE id=?').get(r.lastInsertRowid));
}));

router.patch('/prospects/:id', wrap((req, res) => {
  const b = req.body || {};
  const e = db.prepare('SELECT * FROM prospects WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Introuvable.' });

  const nextStatus = b.status ?? e.status;
  if (!ALLOWED_STATUSES.includes(nextStatus)) return res.status(400).json({ error: 'Statut commercial invalide.' });

  let lostReason = e.lost_reason;
  let lostComment = e.lost_comment;

  if (nextStatus === 'perdu') {
    const reason = b.lost_reason || e.lost_reason;
    if (!reason || !ALLOWED_LOST_REASONS.includes(reason)) {
      return res.status(400).json({ error: 'La raison de la perte est obligatoire lorsque le statut est « Perdu ».' });
    }
    if (reason === 'Autre') {
      const comment = (b.lost_comment !== undefined ? b.lost_comment : e.lost_comment) || '';
      if (!comment.trim()) {
        return res.status(400).json({ error: 'Un commentaire explicatif est obligatoire lorsque la raison est « Autre ».' });
      }
      lostComment = comment.trim();
    } else {
      lostComment = null;
    }
    lostReason = reason;
  } else if (b.status && b.status !== 'perdu') {
    lostReason = null;
    lostComment = null;
  }

  db.prepare(`
    UPDATE prospects
    SET status=?, lost_reason=?, lost_comment=?, next_follow_up=?, notes=?, name=?, phone=?, email=?, source=?
    WHERE id=?
  `).run(
    nextStatus,
    lostReason,
    lostComment,
    b.next_follow_up ?? e.next_follow_up,
    b.notes ?? e.notes,
    b.name ?? e.name,
    b.phone ? R.normPhone(b.phone) : e.phone,
    b.email ?? e.email,
    b.source ?? e.source,
    e.id
  );

  if (nextStatus !== e.status) {
    R.audit(req.userId, 'prospect.status', 'prospect', e.id, { from: e.status, to: nextStatus, lost_reason: lostReason });
  }
  res.json(db.prepare('SELECT * FROM prospects WHERE id=?').get(e.id));
}));

/* ---- Journal des appels & Règle des 3 tentatives sans réponse (Injoignable) ---- */
router.get('/prospects/:id/calls', wrap((req, res) => {
  const p = db.prepare('SELECT id FROM prospects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Prospect introuvable.' });
  const calls = db.prepare(`
    SELECT c.*, u.username caller_name
    FROM prospect_calls c
    LEFT JOIN admin_users u ON u.id = c.user_id
    WHERE c.prospect_id = ?
    ORDER BY c.called_at DESC
  `).all(p.id);
  const unanswered_count = db.prepare('SELECT COUNT(*) c FROM prospect_calls WHERE prospect_id=? AND is_unanswered=1').get(p.id).c;
  res.json({
    calls,
    unanswered_count,
    suggest_unreachable: unanswered_count >= 3
  });
}));

router.post('/prospects/:id/calls', wrap((req, res) => {
  const p = db.prepare('SELECT * FROM prospects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Prospect introuvable.' });
  const b = req.body || {};
  if (!b.result) return res.status(400).json({ error: 'Résultat de l\'appel requis.' });

  // Règle CDC : Une tentative n'est comptée comme sans réponse QUE si le parent n'a pas répondu.
  // 'sans_reponse', 'repondeur', 'occupe' -> is_unanswered = 1
  // 'contacte_interesse', 'contacte_refus', 'contacte_echange' -> is_unanswered = 0
  const is_unanswered = ['sans_reponse', 'repondeur', 'occupe'].includes(b.result) ? 1 : 0;
  const called_at = b.called_at || new Date().toISOString().slice(0, 19).replace('T', ' ');

  const r = db.prepare(`
    INSERT INTO prospect_calls (prospect_id, user_id, called_at, result, is_unanswered, notes)
    VALUES (?,?,?,?,?,?)
  `).run(p.id, req.userId, called_at, b.result, is_unanswered, b.notes || '');

  const unanswered_count = db.prepare('SELECT COUNT(*) c FROM prospect_calls WHERE prospect_id=? AND is_unanswered=1').get(p.id).c;
  let newStatus = p.status;

  // Si demandé explicitement ou si 3 tentatives sans réponse
  if (b.set_injoignable || (b.auto_status && unanswered_count >= 3)) {
    newStatus = 'injoignable';
    db.prepare('UPDATE prospects SET status=? WHERE id=?').run('injoignable', p.id);
    R.audit(req.userId, 'prospect.status', 'prospect', p.id, { from: p.status, to: 'injoignable', reason: '3_unanswered_calls' });
  } else if (!is_unanswered && p.status === 'a_appeler') {
    // Si premier contact réussi et prospect était "à appeler", bascule à "contacté"
    newStatus = 'contacte';
    db.prepare('UPDATE prospects SET status=? WHERE id=?').run('contacte', p.id);
    R.audit(req.userId, 'prospect.status', 'prospect', p.id, { from: p.status, to: 'contacte' });
  }

  R.audit(req.userId, 'prospect.call', 'prospect', p.id, { result: b.result, is_unanswered });
  res.status(201).json({
    id: r.lastInsertRowid,
    unanswered_count,
    suggest_unreachable: unanswered_count >= 3,
    status: newStatus
  });
}));

/* ---- Enfants saisis sur le prospect / RDV ---- */
router.get('/prospects/:id/children', wrap((req, res) => {
  res.json(db.prepare('SELECT * FROM prospect_children WHERE prospect_id=? ORDER BY id ASC').all(req.params.id));
}));

router.post('/prospects/:id/children', wrap((req, res) => {
  const p = db.prepare('SELECT id FROM prospects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Prospect introuvable.' });
  const b = req.body || {};
  if (!b.prenom || !b.nom) return res.status(400).json({ error: 'Prénom et nom de l\'enfant requis.' });
  const r = db.prepare(`
    INSERT INTO prospect_children (prospect_id, appointment_id, prenom, nom, age, level, interests)
    VALUES (?,?,?,?,?,?,?)
  `).run(p.id, b.appointment_id || null, b.prenom.trim(), b.nom.trim(), b.age ? Number(b.age) : null, b.level || '', b.interests || '');
  res.status(201).json({ id: r.lastInsertRowid });
}));

// Route dépréciée pour compatibilité : conversion directe bloquée conformément au CDC §4
router.post('/prospects/:id/convert', wrap((req, res) => {
  const p = db.prepare('SELECT * FROM prospects WHERE id=?').get(req.params.id); if (!p) return res.status(404).json({ error: 'Introuvable.' });
  const app = db.prepare("SELECT * FROM appointments WHERE prospect_id=? AND result='inscription' ORDER BY date_time DESC LIMIT 1").get(p.id);
  if (!app && !req.body.force) {
    return res.status(400).json({
      error: 'La conversion directe depuis la fiche prospect est désactivée (CDC §4). Le passage à une famille et aux inscriptions doit se faire après un rendez-vous dont le résultat est « Inscription ».'
    });
  }
  const f = db.prepare('INSERT INTO families (parent_name,phone,email,source) VALUES (?,?,?,?)').run(p.name, p.phone, p.email, p.source);
  db.prepare("UPDATE prospects SET family_id=?, status='converti' WHERE id=?").run(f.lastInsertRowid, p.id);
  R.audit(req.userId, 'prospect.convert', 'prospect', p.id, { family_id: f.lastInsertRowid });
  res.status(201).json({ family_id: f.lastInsertRowid });
}));

router.get('/tasks', wrap((req, res) => {
  const v = req.query.view; const today = new Date().toISOString().slice(0, 10);
  const cond = v === 'late' ? 'due_at < ?' : v === 'upcoming' ? 'due_at > ?' : 'substr(due_at,1,10) = ?';
  const arg = v === 'late' ? today : v === 'upcoming' ? today + 'T23:59:59' : today;
  res.json(db.prepare(`SELECT * FROM tasks WHERE status='todo' AND ${cond} ORDER BY due_at`).all(arg));
}));
router.post('/tasks', wrap((req, res) => {
  const b = req.body || {}; if (!need(res, b, ['due_at'])) return;
  const r = db.prepare('INSERT INTO tasks (prospect_id,type,due_at,assignee,note) VALUES (?,?,?,?,?)').run(b.prospect_id || null, b.type || 'rappel', b.due_at, b.assignee || req.userId, b.note || '');
  res.status(201).json({ id: r.lastInsertRowid });
}));
router.patch('/tasks/:id', wrap((req, res) => { db.prepare('UPDATE tasks SET status=? WHERE id=?').run(req.body.status === 'done' ? 'done' : 'todo', req.params.id); res.json({ ok: true }); }));

/* ---- Rendez-vous (report = nouvelle occurrence liée & multi-enfants) ---- */
router.get('/appointments', wrap((req, res) => {
  const { status, from, to } = req.query; let sql = 'SELECT a.*, p.name prospect_name, p.phone FROM appointments a LEFT JOIN prospects p ON p.id=a.prospect_id WHERE 1=1'; const p = [];
  if (status) { sql += ' AND a.status=?'; p.push(status); } if (from) { sql += ' AND a.date_time>=?'; p.push(from); } if (to) { sql += ' AND a.date_time<=?'; p.push(to); }
  const rows = db.prepare(sql + ' ORDER BY a.date_time').all(...p);
  res.json(rows.map(a => ({
    ...a,
    children: db.prepare('SELECT * FROM prospect_children WHERE appointment_id=? OR (appointment_id IS NULL AND prospect_id=?)').all(a.id, a.prospect_id)
  })));
}));

router.get('/appointments/:id', wrap((req, res) => {
  const a = db.prepare('SELECT a.*, p.name prospect_name, p.phone FROM appointments a LEFT JOIN prospects p ON p.id=a.prospect_id WHERE a.id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Rendez-vous introuvable.' });
  const children = db.prepare('SELECT * FROM prospect_children WHERE appointment_id=? OR (appointment_id IS NULL AND prospect_id=?)').all(a.id, a.prospect_id);
  res.json({ ...a, children });
}));

router.post('/appointments', wrap((req, res) => {
  const b = req.body || {}; if (!need(res, b, ['prospect_id', 'date_time'])) return;
  const p = db.prepare('SELECT * FROM prospects WHERE id=?').get(b.prospect_id);
  if (!p) return res.status(404).json({ error: 'Prospect introuvable.' });

  const r = db.prepare(`
    INSERT INTO appointments (prospect_id,date_time,duration_minutes,type,notes,responsible)
    VALUES (?,?,?,?,?,?)
  `).run(b.prospect_id, b.date_time, b.duration_minutes || 30, b.type || 'decouverte', b.notes || '', req.userId);
  const appId = r.lastInsertRowid;

  // Enregistrement des enfants saisis pour ce rendez-vous (CDC §3)
  if (Array.isArray(b.children)) {
    const insKid = db.prepare(`
      INSERT INTO prospect_children (prospect_id, appointment_id, prenom, nom, age, level, interests)
      VALUES (?,?,?,?,?,?,?)
    `);
    for (const k of b.children) {
      if (k.prenom && k.nom) {
        insKid.run(p.id, appId, k.prenom.trim(), k.nom.trim(), k.age ? Number(k.age) : null, k.level || '', k.interests || '');
      }
    }
  }

  R.audit(req.userId, 'appointment.create', 'appointment', appId, { children_count: Array.isArray(b.children) ? b.children.length : 0 });
  res.status(201).json({ id: appId });
}));

router.patch('/appointments/:id', wrap((req, res) => {
  const e = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const b = req.body || {};

  db.prepare(`
    UPDATE appointments SET status=?, attendance=?, result=?, notes=?, date_time=?, type=? WHERE id=?
  `).run(
    b.status ?? e.status,
    b.attendance ?? e.attendance,
    b.result ?? e.result,
    b.notes ?? e.notes,
    b.date_time ?? e.date_time,
    b.type ?? e.type,
    e.id
  );

  // Mise à jour éventuelle des enfants rattachés
  if (Array.isArray(b.children)) {
    db.prepare('DELETE FROM prospect_children WHERE appointment_id=?').run(e.id);
    const insKid = db.prepare(`
      INSERT INTO prospect_children (prospect_id, appointment_id, prenom, nom, age, level, interests)
      VALUES (?,?,?,?,?,?,?)
    `);
    for (const k of b.children) {
      if (k.prenom && k.nom) {
        insKid.run(e.prospect_id, e.id, k.prenom.trim(), k.nom.trim(), k.age ? Number(k.age) : null, k.level || '', k.interests || '');
      }
    }
  }

  R.audit(req.userId, 'appointment.update', 'appointment', e.id, b);
  res.json({ ok: true });
}));

router.post('/appointments/:id/reschedule', wrap((req, res) => {
  const e = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  if (!need(res, req.body || {}, ['date_time'])) return;
  const tx = db.transaction(() => {
    db.prepare("UPDATE appointments SET status='reporte' WHERE id=?").run(e.id);
    const newId = db.prepare('INSERT INTO appointments (prospect_id,date_time,duration_minutes,type,responsible,rescheduled_from) VALUES (?,?,?,?,?,?)')
      .run(e.prospect_id, req.body.date_time, e.duration_minutes, e.type, e.responsible, e.id).lastInsertRowid;
    // Dupliquer les enfants sur la nouvelle occurrence
    const kids = db.prepare('SELECT * FROM prospect_children WHERE appointment_id=?').all(e.id);
    const insKid = db.prepare('INSERT INTO prospect_children (prospect_id, appointment_id, prenom, nom, age, level, interests) VALUES (?,?,?,?,?,?,?)');
    kids.forEach(k => insKid.run(e.prospect_id, newId, k.prenom, k.nom, k.age, k.level, k.interests));
    return newId;
  });
  const id = tx();
  R.audit(req.userId, 'appointment.reschedule', 'appointment', e.id, { new_id: id });
  res.status(201).json({ id, rescheduled_from: e.id });
}));

/* ---- Passage à la famille et inscription après RDV réussi (CDC §4, §6, §7) ---- */
router.post('/appointments/:id/convert-to-family', wrap((req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Rendez-vous introuvable.' });
  if (a.result !== 'inscription') {
    return res.status(400).json({
      error: 'Le passage à une famille et aux inscriptions nécessite un rendez-vous dont le résultat est « Inscription » (CDC §4).'
    });
  }

  const p = db.prepare('SELECT * FROM prospects WHERE id=?').get(a.prospect_id);
  if (!p) return res.status(404).json({ error: 'Prospect introuvable.' });

  // Si la famille existe déjà pour ce prospect
  if (p.family_id) {
    return res.json({
      family_id: p.family_id,
      already_converted: true,
      children: db.prepare('SELECT * FROM children WHERE family_id=?').all(p.family_id)
    });
  }

  const tx = db.transaction(() => {
    // 1. Création de la fiche famille
    const f = db.prepare(`
      INSERT INTO families (parent_name, phone, email, source)
      VALUES (?,?,?,?)
    `).run(p.name, p.phone, p.email, p.source);
    const familyId = f.lastInsertRowid;

    // 2. Transfert automatique des enfants saisis lors du RDV
    const prospectKids = db.prepare(`
      SELECT * FROM prospect_children WHERE appointment_id=? OR (appointment_id IS NULL AND prospect_id=?)
    `).all(a.id, p.id);

    const createdChildren = [];
    const insKid = db.prepare(`
      INSERT INTO children (family_id, prenom, nom, level, interests, notes)
      VALUES (?,?,?,?,?,?)
    `);

    if (prospectKids.length > 0) {
      for (const pk of prospectKids) {
        const kRes = insKid.run(
          familyId,
          pk.prenom,
          pk.nom,
          pk.level || '',
          pk.interests || '',
          pk.age ? `Âge au RDV : ${pk.age} ans` : ''
        );
        createdChildren.push({ id: kRes.lastInsertRowid, prenom: pk.prenom, nom: pk.nom });
      }
    } else {
      // Si aucun enfant spécifique n'avait été saisi, créer une fiche avec le nom du prospect
      const parts = p.name.split(' ');
      const prenom = parts[0] || 'Enfant';
      const nom = parts.slice(1).join(' ') || p.name;
      const kRes = insKid.run(familyId, prenom, nom, '', '', 'Créé automatiquement depuis prospect');
      createdChildren.push({ id: kRes.lastInsertRowid, prenom, nom });
    }

    // 3. Passage du prospect au statut commercial "converti"
    db.prepare("UPDATE prospects SET family_id=?, status='converti' WHERE id=?").run(familyId, p.id);

    return { familyId, createdChildren };
  });

  const out = tx();
  R.audit(req.userId, 'appointment.convert_to_family', 'appointment', a.id, { family_id: out.familyId, children_count: out.createdChildren.length });
  res.status(201).json(out);
}));

/* ---- Familles & enfants (CIN masquée sauf admin) ---- */
router.post('/families', wrap((req, res) => {
  const b = req.body || {}; if (!need(res, b, ['parent_name', 'phone'])) return;
  const r = db.prepare('INSERT INTO families (parent_name,phone,email,address,cin,source) VALUES (?,?,?,?,?,?)').run(b.parent_name, R.normPhone(b.phone), b.email || '', b.address || '', b.cin || null, b.source || '');
  res.status(201).json({ id: r.lastInsertRowid });
}));
router.get('/families', wrap((req, res) => {
  const q = `%${req.query.q || ''}%`;
  res.json(db.prepare('SELECT id,parent_name,phone,email FROM families WHERE parent_name LIKE ? OR phone LIKE ? ORDER BY id DESC LIMIT 100').all(q, q));
}));
router.get('/families/:id', wrap((req, res) => {
  const f = db.prepare('SELECT * FROM families WHERE id=?').get(req.params.id); if (!f) return res.status(404).json({ error: 'Introuvable.' });
  f.cin = req.role === 'admin' ? f.cin : mask(f.cin);
  res.json({ ...f, children: db.prepare('SELECT * FROM children WHERE family_id=?').all(f.id), enrollments: db.prepare('SELECT id,number,child_id,status,end_date FROM enrollments WHERE family_id=?').all(f.id) });
}));
router.get('/families/:id/parent-link', wrap((req, res) => {
  const f = db.prepare('SELECT id FROM families WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Famille introuvable.' });
  const token = R.issueParentToken(f.id);
  res.json({ token, url: `/parent?token=${token}` });
}));
router.post('/families/:id/children', wrap((req, res) => {
  const b = req.body || {}; if (!need(res, b, ['prenom', 'nom'])) return;
  const r = db.prepare('INSERT INTO children (family_id,prenom,nom,birth_date,interests,level,notes) VALUES (?,?,?,?,?,?,?)').run(req.params.id, b.prenom, b.nom, b.birth_date || null, b.interests || '', b.level || '', b.notes || '');
  res.status(201).json({ id: r.lastInsertRowid });
}));
router.get('/children', wrap((req, res) => {
  res.json(db.prepare(`
    SELECT c.*, f.parent_name, f.phone parent_phone
    FROM children c
    JOIN families f ON f.id = c.family_id
    ORDER BY c.nom, c.prenom
  `).all());
}));

/* ---- Inscriptions ---- */
router.get('/enrollments', wrap((req, res) => {
  const { q, status } = req.query;
  let sql = `
    SELECT e.*, c.prenom child_prenom, c.nom child_nom, f.parent_name, f.phone parent_phone
    FROM enrollments e
    JOIN children c ON c.id = e.child_id
    JOIN families f ON f.id = e.family_id
    WHERE 1=1
  `;
  const p = [];
  if (status) { sql += ' AND e.status=?'; p.push(status); }
  if (q) {
    sql += ' AND (e.number LIKE ? OR c.prenom LIKE ? OR c.nom LIKE ? OR f.parent_name LIKE ? OR f.phone LIKE ?)';
    p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY e.id DESC LIMIT 150';
  const rows = db.prepare(sql).all(...p).map(row => ({
    ...row,
    modules: JSON.parse(row.modules || '[]'),
    balance: R.balance(row.id),
  }));
  res.json(rows);
}));
router.post('/enrollments', wrap((req, res) => {
  const b = req.body || {}; if (!need(res, b, ['child_id', 'plan_months', 'modules', 'total_amount'])) return;
  const ch = db.prepare('SELECT * FROM children WHERE id=?').get(b.child_id); if (!ch) return res.status(404).json({ error: 'Enfant introuvable.' });
  const start = b.start_date || new Date().toISOString().slice(0, 10);
  const r = db.prepare('INSERT INTO enrollments (child_id,family_id,plan_months,start_date,end_date,modules,weekly_limit,total_amount) VALUES (?,?,?,?,?,?,?,?)')
    .run(ch.id, ch.family_id, b.plan_months, start, b.end_date || R.addMonths(start, Number(b.plan_months)), JSON.stringify(b.modules), b.weekly_limit || Number(R.setting('weekly_limit', '3')), b.total_amount);
  db.prepare('UPDATE enrollments SET number=? WHERE id=?').run(`INS-${year()}-${String(r.lastInsertRowid).padStart(4, '0')}`, r.lastInsertRowid);
  R.audit(req.userId, 'enrollment.create', 'enrollment', r.lastInsertRowid); res.status(201).json({ id: r.lastInsertRowid });
}));
router.get('/enrollments/:id', wrap((req, res) => {
  const e = db.prepare('SELECT * FROM enrollments WHERE id=?').get(req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  res.json({ ...e, modules: JSON.parse(e.modules), balance: R.balance(e.id), payments: db.prepare('SELECT * FROM payments WHERE enrollment_id=? ORDER BY paid_at').all(e.id) });
}));
router.patch('/enrollments/:id', wrap((req, res) => {
  const { status } = req.body || {}; if (!['en_attente', 'active', 'suspendue', 'terminee', 'annulee'].includes(status)) return res.status(400).json({ error: 'Statut invalide.' });
  const e = db.prepare('SELECT * FROM enrollments WHERE id=?').get(req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  db.prepare('UPDATE enrollments SET status=? WHERE id=?').run(status, e.id);
  R.audit(req.userId, 'enrollment.status', 'enrollment', e.id, { from: e.status, to: status });
  // L'envoi d'email n'est pas encore branché : le lien est renvoyé à l'accueil pour transmission.
  const out = { ok: true }; if (status === 'active') out.parent_link = `/parent?token=${R.issueParentToken(e.family_id)}`;
  res.json(out);
}));

/* ---- Paiements (jamais supprimés : annulation tracée) ---- */
router.get('/payments', wrap((req, res) => {
  const { q, status } = req.query;
  let sql = `
    SELECT p.*, e.number enrollment_number, c.prenom child_prenom, c.nom child_nom, f.parent_name, u.username created_by_name
    FROM payments p
    JOIN enrollments e ON e.id = p.enrollment_id
    JOIN children c ON c.id = e.child_id
    JOIN families f ON f.id = e.family_id
    LEFT JOIN admin_users u ON u.id = p.user_id
    WHERE 1=1
  `;
  const p = [];
  if (status) { sql += ' AND p.status=?'; p.push(status); }
  if (q) {
    sql += ' AND (p.ref LIKE ? OR e.number LIKE ? OR c.prenom LIKE ? OR c.nom LIKE ? OR f.parent_name LIKE ?)';
    p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY p.id DESC LIMIT 150';
  res.json(db.prepare(sql).all(...p));
}));
router.get('/payments/:id/receipt', wrap((req, res) => {
  const p = db.prepare(`
    SELECT p.*, e.number enrollment_number, e.total_amount, e.plan_months, e.start_date, e.end_date,
           c.prenom child_prenom, c.nom child_nom, f.parent_name, f.phone, f.address,
           u.username created_by_name
    FROM payments p
    JOIN enrollments e ON e.id = p.enrollment_id
    JOIN children c ON c.id = e.child_id
    JOIN families f ON f.id = e.family_id
    LEFT JOIN admin_users u ON u.id = p.user_id
    WHERE p.id=?
  `).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Paiement introuvable.' });
  const bal = R.balance(p.enrollment_id);
  res.json({ payment: p, balance: bal });
}));
router.post('/enrollments/:id/payments', wrap((req, res) => {
  const b = req.body || {}; if (!need(res, b, ['amount'])) return; if (!(Number(b.amount) > 0)) return res.status(400).json({ error: 'Montant strictement positif requis.' });
  if (!db.prepare('SELECT 1 FROM enrollments WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Inscription introuvable.' });
  const r = db.prepare('INSERT INTO payments (enrollment_id,paid_at,amount,method,external_ref,user_id) VALUES (?,?,?,?,?,?)').run(req.params.id, b.paid_at || new Date().toISOString().slice(0, 10), b.amount, b.method || 'especes', b.external_ref || '', req.userId);
  db.prepare('UPDATE payments SET ref=? WHERE id=?').run(`REC-${year()}-${String(r.lastInsertRowid).padStart(5, '0')}`, r.lastInsertRowid);
  R.audit(req.userId, 'payment.create', 'payment', r.lastInsertRowid, { amount: b.amount });
  res.status(201).json({ id: r.lastInsertRowid, balance: R.balance(Number(req.params.id)) });
}));
router.post('/payments/:id/cancel', wrap((req, res) => {
  if (!(req.body || {}).reason) return res.status(400).json({ error: 'Motif requis.' });
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id); if (!p) return res.status(404).json({ error: 'Introuvable.' });
  db.prepare("UPDATE payments SET status='annule', cancel_reason=? WHERE id=?").run(req.body.reason, p.id);
  R.audit(req.userId, 'payment.cancel', 'payment', p.id, { reason: req.body.reason }); res.json({ balance: R.balance(p.enrollment_id) });
}));
router.get('/reports/finance', wrap((req, res) => {
  const from = req.query.from || '0000', to = req.query.to || '9999';
  res.json({
    invoiced: db.prepare('SELECT COALESCE(SUM(total_amount),0) s FROM enrollments WHERE status!=\'annulee\' AND substr(created_at,1,10) BETWEEN ? AND ?').get(from, to).s,
    collected: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='enregistre' AND paid_at BETWEEN ? AND ?").get(from, to).s,
    cancelled_or_refunded: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='annule' AND paid_at BETWEEN ? AND ?").get(from, to).s,
  });
}));

router.get('/dashboard-metrics', wrap((req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const next7Days = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);

  const prospectsToCall = db.prepare("SELECT COUNT(*) c FROM prospects WHERE status IN ('a_appeler', 'a_relancer')").get().c;
  const lateTasks = db.prepare("SELECT COUNT(*) c FROM tasks WHERE status='todo' AND due_at < ?").get(today).c;
  const todayAppointments = db.prepare("SELECT COUNT(*) c FROM appointments WHERE substr(date_time,1,10) = ?").get(today).c;
  const activeEnrollments = db.prepare("SELECT COUNT(*) c FROM enrollments WHERE status='active'").get().c;
  const expiringEnrollments = db.prepare("SELECT COUNT(*) c FROM enrollments WHERE status='active' AND end_date BETWEEN ? AND ?").get(today, next7Days).c;
  const todaySessions = db.prepare("SELECT COUNT(*) c FROM slots WHERE date = ? AND active=1").get(today).c;
  const monthStart = today.slice(0, 7) + '-01';
  const monthCollected = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='enregistre' AND paid_at >= ?").get(monthStart).s;

  const totalSlotsCapacity = db.prepare("SELECT COALESCE(SUM(capacity),0) s FROM slots WHERE date >= ? AND active=1").get(today).s;
  const totalBookingsCount = db.prepare("SELECT COUNT(*) c FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE s.date >= ? AND b.status!='cancelled'").get(today).c;

  res.json({
    prospectsToCall,
    lateTasks,
    todayAppointments,
    activeEnrollments,
    expiringEnrollments,
    todaySessions,
    monthCollected,
    totalSlotsCapacity,
    totalBookingsCount,
  });
}));

/* ---- Réservations (admin/accueil) & présences (coach limité à ses séances) ---- */
router.post('/bookings/for-child', wrap((req, res) => {
  const { enrollment_id, slot_id } = req.body || {};
  const id = R.bookSlot.immediate(enrollment_id, slot_id); R.audit(req.userId, 'booking.create', 'booking', id); res.status(201).json({ id });
}));
router.post('/bookings/:id/cancel', wrap((req, res) => { const r = R.cancelBooking(req.params.id, 'center'); R.audit(req.userId, 'booking.cancel_center', 'booking', Number(req.params.id)); res.json(r); }));
router.patch('/slots/:id/coach', wrap((req, res) => { db.prepare('UPDATE slots SET coach_id=? WHERE id=?').run(req.body.coach_id || null, req.params.id); res.json({ ok: true }); }));
router.get('/sessions', wrap((req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  let sql = 'SELECT s.*, m.title module_title FROM slots s JOIN modules m ON m.id=s.module_id WHERE s.date=?'; const p = [date];
  if (req.role === 'coach') { sql += ' AND s.coach_id=?'; p.push(req.userId); }
  res.json(db.prepare(sql + ' ORDER BY s.time').all(...p));
}));
router.get('/sessions/:slotId/roster', wrap((req, res) => {
  const s = db.prepare('SELECT coach_id FROM slots WHERE id=?').get(req.params.slotId); if (!s) return res.status(404).json({ error: 'Introuvable.' });
  if (req.role === 'coach' && s.coach_id !== req.userId) return res.status(403).json({ error: 'Séance non attribuée.' });
  res.json(db.prepare("SELECT id,prenom,nom,status FROM bookings WHERE slot_id=? AND status!='cancelled'").all(req.params.slotId));
}));
router.patch('/attendance/:bookingId', wrap((req, res) => {
  const st = (req.body || {}).status; if (!['attended', 'absent', 'absent_excuse', 'confirmed'].includes(st)) return res.status(400).json({ error: 'Statut invalide.' });
  const b = db.prepare('SELECT b.*, s.coach_id FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE b.id=?').get(req.params.bookingId); if (!b) return res.status(404).json({ error: 'Introuvable.' });
  if (req.role === 'coach' && b.coach_id !== req.userId) return res.status(403).json({ error: 'Séance non attribuée.' });
  db.prepare('UPDATE bookings SET status=? WHERE id=?').run(st, b.id);
  R.audit(req.userId, 'attendance.set', 'booking', b.id, { from: b.status, to: st }); res.json({ ok: true });
}));
module.exports = router;
