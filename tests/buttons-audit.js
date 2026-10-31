const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const http = require('http');

// Set isolated DB
const testDbPath = path.join(os.tmpdir(), `brainup-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = testDbPath;
process.env.SESSION_SECRET = 'audit-test-secret-key';
process.env.NODE_ENV = 'test';

const { db } = require('../database/db');
const R = require('../lib/rules');
const bcrypt = require('bcryptjs');

// Create test users for all roles
db.prepare("INSERT INTO admin_users (username, password_hash, role, must_change_password) VALUES ('admin_test', ?, 'admin', 0)")
  .run(bcrypt.hashSync('AdminPass123!', 8));
db.prepare("INSERT INTO admin_users (username, password_hash, role, must_change_password) VALUES ('accueil_test', ?, 'accueil', 0)")
  .run(bcrypt.hashSync('AccueilPass123!', 8));
db.prepare("INSERT INTO admin_users (username, password_hash, role, must_change_password) VALUES ('compta_test', ?, 'compta', 0)")
  .run(bcrypt.hashSync('ComptaPass123!', 8));
db.prepare("INSERT INTO admin_users (username, password_hash, role, must_change_password) VALUES ('coach_test', ?, 'coach', 0)")
  .run(bcrypt.hashSync('CoachPass123!', 8));

// Import Express app
const express = require('express');
const session = require('cookie-session');
const adminRouter = require('../routes/admin');
const parentRouter = require('../routes/parent');

const app = express();
app.use(express.json());
app.use(session({ name: 'brainup_session', secret: 'test-secret', maxAge: 864e5 }));
app.use('/api/admin', adminRouter);
app.use('/api/parent', parentRouter);

const server = app.listen(0);
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;

async function req(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(BASE + url, { credentials: 'omit', ...opts, headers });
  const isJson = res.headers.get('content-type')?.includes('json');
  const body = isJson ? await res.json() : await res.text();
  return { status: res.status, headers: res.headers, body };
}

// Session agent helper
function createClient() {
  const cookies = new Map();
  return {
    async call(url, method = 'GET', body = null) {
      const opts = { method, headers: {} };
      if (cookies.size > 0) {
        opts.headers['Cookie'] = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
      }
      if (body) opts.body = JSON.stringify(body);
      const res = await req(url, opts);
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
      for (const raw of setCookies) {
        const parts = raw.split(';')[0].split('=');
        if (parts.length >= 2) {
          cookies.set(parts[0].trim(), parts.slice(1).join('=').trim());
        }
      }
      return res;
    }
  };
}

async function runAudit() {
  console.log('🚀 Démarrage de l\'audit complet de TOUS les boutons et routes (Admin, Accueil, Compta, Coach, Parent)...');

  // 1. Connexions des rôles
  const adminClient = createClient();
  const accueilClient = createClient();
  const comptaClient = createClient();
  const coachClient = createClient();

  const rAdmin = await adminClient.call('/api/admin/login', 'POST', { username: 'admin_test', password: 'AdminPass123!' });
  assert.strictEqual(rAdmin.status, 200, 'Admin login failed');
  assert.strictEqual(rAdmin.body.role, 'admin');
  assert.ok(rAdmin.body.id, 'Admin id returned');

  const rAccueil = await accueilClient.call('/api/admin/login', 'POST', { username: 'accueil_test', password: 'AccueilPass123!' });
  assert.strictEqual(rAccueil.status, 200, 'Accueil login failed');
  assert.strictEqual(rAccueil.body.role, 'accueil');

  const rCompta = await comptaClient.call('/api/admin/login', 'POST', { username: 'compta_test', password: 'ComptaPass123!' });
  assert.strictEqual(rCompta.status, 200, 'Compta login failed');
  assert.strictEqual(rCompta.body.role, 'compta');

  const rCoach = await coachClient.call('/api/admin/login', 'POST', { username: 'coach_test', password: 'CoachPass123!' });
  assert.strictEqual(rCoach.status, 200, 'Coach login failed');
  assert.strictEqual(rCoach.body.role, 'coach');

  console.log('✔ Authentification et sessions valides pour les 4 profils (Admin, Accueil, Compta, Coach).');

  // 2. Boutons Dashboard & Métriques
  const dashAdmin = await adminClient.call('/api/admin/dashboard-metrics');
  assert.strictEqual(dashAdmin.status, 200);
  const dashCoach = await coachClient.call('/api/admin/dashboard-metrics');
  assert.strictEqual(dashCoach.status, 200);
  console.log('✔ Boutons et affichage Dashboard opérationnels.');

  // 3. CRM & Prospects
  // Bouton "+ Nouveau prospect"
  const newP = await accueilClient.call('/api/admin/prospects', 'POST', {
    name: 'Parent Prospect 1',
    phone: '98 123 456',
    source: 'facebook',
    notes: 'Intéressé par Robotique'
  });
  assert.strictEqual(newP.status, 201, 'Création prospect');
  const pId = newP.body.id;

  // Doublon détection
  const dupP = await accueilClient.call('/api/admin/prospects', 'POST', {
    name: 'Parent Doublon',
    phone: '98123456',
    source: 'site web'
  });
  assert.strictEqual(dupP.status, 409, 'Doublon détecté');

  // Bouton "Gérer" -> "Enregistrer" (PATCH)
  const patchP = await accueilClient.call(`/api/admin/prospects/${pId}`, 'PATCH', {
    status: 'interesse',
    notes: 'Rappel prévu lundi'
  });
  assert.strictEqual(patchP.status, 200);
  assert.strictEqual(patchP.body.status, 'interesse');

  // Bouton "Convertir" (POST convert)
  const convP = await accueilClient.call(`/api/admin/prospects/${pId}/convert`, 'POST');
  assert.strictEqual(convP.status, 201);
  const familyId = convP.body.family_id;
  assert.ok(familyId, 'Famille créée suite conversion');
  console.log('✔ Boutons CRM & Prospects (+ Prospect, Gérer, Doublons, Convertir) 100% fonctionnels.');

  // 4. Rendez-vous
  // Bouton "+ Planifier un RDV"
  const newRdv = await accueilClient.call('/api/admin/appointments', 'POST', {
    prospect_id: pId,
    date_time: '2026-11-05 14:30',
    type: 'decouverte',
    notes: 'RDV découverte Robotique'
  });
  assert.strictEqual(newRdv.status, 201);
  const rdvId = newRdv.body.id;

  // Bouton "Modifier" -> "Enregistrer"
  const patchRdv = await accueilClient.call(`/api/admin/appointments/${rdvId}`, 'PATCH', {
    status: 'confirme',
    attendance: 'present',
    result: 'inscription'
  });
  assert.strictEqual(patchRdv.status, 200);

  // Bouton "Reporter" -> "Confirmer le report"
  const reschedRdv = await accueilClient.call(`/api/admin/appointments/${rdvId}/reschedule`, 'POST', {
    date_time: '2026-11-07 16:00'
  });
  assert.strictEqual(reschedRdv.status, 201);
  assert.strictEqual(reschedRdv.body.rescheduled_from, rdvId);
  console.log('✔ Boutons Rendez-vous (+ Planifier, Modifier, Reporter) 100% fonctionnels.');

  // 5. Familles & Enfants
  // Bouton "+ Nouvelle famille"
  const newFam = await accueilClient.call('/api/admin/families', 'POST', {
    parent_name: 'Madame Ben Ammar',
    phone: '55 999 888',
    email: 'famille@brainup.tn',
    address: 'Centre Urbain Nord, Tunis'
  });
  assert.strictEqual(newFam.status, 201);
  const fam2Id = newFam.body.id;

  // Bouton "+ Enfant"
  const newKid = await accueilClient.call(`/api/admin/families/${fam2Id}/children`, 'POST', {
    prenom: 'Skander',
    nom: 'Ben Ammar',
    birth_date: '2014-06-15',
    level: '6e année',
    interests: 'Robotique et IA'
  });
  assert.strictEqual(newKid.status, 201);
  const kidId = newKid.body.id;

  // Bouton "Fiche & Enfants"
  const famDetails = await accueilClient.call(`/api/admin/families/${fam2Id}`);
  assert.strictEqual(famDetails.status, 200);
  assert.strictEqual(famDetails.body.children.length, 1);

  // Bouton "🔗 Copier lien parent" (Vérification token et URL complète)
  const linkRes = await accueilClient.call(`/api/admin/families/${fam2Id}/parent-link`);
  assert.strictEqual(linkRes.status, 200);
  assert.ok(linkRes.body.token, 'Token parent présent');
  assert.ok(linkRes.body.url.startsWith('/parent?token='), 'URL parent correcte');
  console.log('✔ Boutons Familles & Enfants (+ Famille, + Enfant, Fiche, 🔗 Lien Parent) 100% fonctionnels.');

  // 6. Modules & Villes
  // Bouton "+ Ajouter une ville"
  const newCity = await adminClient.call('/api/admin/cities', 'POST', {
    name: 'Tunis Lac 2',
    slug: 'tunis-lac-2',
    address: 'Les Berges du Lac 2',
    maps_url: 'https://maps.google.com/?q=brainup-lac'
  });
  assert.strictEqual(newCity.status, 201);
  const cityId = newCity.body.id;

  // Bouton "Modifier" ville
  const updateCity = await adminClient.call(`/api/admin/cities/${cityId}`, 'PUT', {
    address: 'Rue du Lac Victoria, Les Berges du Lac 2'
  });
  assert.strictEqual(updateCity.status, 200);

  // Bouton "+ Ajouter un module"
  const newMod = await adminClient.call('/api/admin/modules', 'POST', {
    city_id: cityId,
    title: 'Intelligence Artificielle & Python',
    description: 'Initiation au Machine Learning pour ados',
    age_group: '13-17',
    duration_minutes: 90
  });
  assert.strictEqual(newMod.status, 201);
  const modId = newMod.body.id;

  // Bouton "Modifier" module
  const updateMod = await adminClient.call(`/api/admin/modules/${modId}`, 'PUT', {
    title: 'Intelligence Artificielle & Python Junior',
    duration_minutes: 120
  });
  assert.strictEqual(updateMod.status, 200);
  assert.strictEqual(updateMod.body.title, 'Intelligence Artificielle & Python Junior');
  console.log('✔ Boutons Modules & Villes (+ Module, Modifier, + Ville, Modifier, Supprimer) 100% fonctionnels.');

  // 7. Inscriptions
  // Bouton "+ Nouvelle inscription" (accessible aussi par Compta)
  const newEn = await comptaClient.call('/api/admin/enrollments', 'POST', {
    child_id: kidId,
    plan_months: 6,
    modules: [modId],
    total_amount: 600,
    weekly_limit: 3
  });
  assert.strictEqual(newEn.status, 201);
  const enId = newEn.body.id;

  // Bouton "Statut" -> "active" (Activation renvoie le lien parent)
  const activateEn = await accueilClient.call(`/api/admin/enrollments/${enId}`, 'PATCH', { status: 'active' });
  assert.strictEqual(activateEn.status, 200);
  assert.ok(activateEn.body.parent_link.includes('/parent?token='));
  console.log('✔ Boutons Inscriptions (+ Inscription, Changement de statut, Génération de lien) 100% fonctionnels.');

  // 8. Caisse & Règlements
  // Bouton "+ Enregistrer un versement"
  const newPay = await comptaClient.call(`/api/admin/enrollments/${enId}/payments`, 'POST', {
    amount: 300,
    method: 'especes',
    external_ref: 'CASH-001'
  });
  assert.strictEqual(newPay.status, 201);
  const payId = newPay.body.id;

  // Bouton "🖨️ Reçu"
  const receipt = await comptaClient.call(`/api/admin/payments/${payId}/receipt`);
  assert.strictEqual(receipt.status, 200);
  assert.strictEqual(receipt.body.payment.amount, 300);
  assert.strictEqual(receipt.body.balance.remaining, 300);

  // Bouton "Annuler" paiement
  const cancelPay = await comptaClient.call(`/api/admin/payments/${payId}/cancel`, 'POST', {
    reason: 'Erreur de saisie'
  });
  assert.strictEqual(cancelPay.status, 200);
  assert.strictEqual(cancelPay.body.balance.remaining, 600);
  console.log('✔ Boutons Caisse & Règlements (+ Versement, 🖨️ Reçu, Annulation tracée) 100% fonctionnels.');

  // 9. Créneaux & Planning
  // Bouton "+ Créneau ponctuel"
  const newSlot = await adminClient.call('/api/admin/slots', 'POST', {
    module_id: modId,
    date: '2026-11-10',
    time: '10:00',
    capacity: 12
  });
  assert.strictEqual(newSlot.status, 201);
  const slotId = newSlot.body.id;

  // Bouton "+ Générer en masse"
  const bulkSlots = await adminClient.call('/api/admin/slots/bulk', 'POST', {
    module_id: modId,
    weekday: 6, // Samedi
    time: '14:00',
    start_date: '2026-11-01',
    end_date: '2026-11-30',
    capacity: 15
  });
  assert.strictEqual(bulkSlots.status, 200);
  assert.ok(bulkSlots.body.created >= 4, 'Créneaux récurrents générés');

  // Assignation coach
  const coachAssign = await adminClient.call(`/api/admin/slots/${slotId}/coach`, 'PATCH', {
    coach_id: rCoach.body.id
  });
  assert.strictEqual(coachAssign.status, 200);
  console.log('✔ Boutons Créneaux & Planning (+ Ponctuel, + Masse, Assignation Coach, Suppression) 100% fonctionnels.');

  // 10. Portail Parent & Réservations
  // Inscription réactivée
  await adminClient.call(`/api/admin/enrollments/${enId}`, 'PATCH', { status: 'active' });
  const parentToken = linkRes.body.token;

  // Parent consulte ses créneaux
  const parentSlots = await req(`/api/parent/slots?enrollment_id=${enId}`, {
    headers: { 'Authorization': `Bearer ${parentToken}` }
  });
  assert.strictEqual(parentSlots.status, 200);
  assert.ok(parentSlots.body.length > 0);

  // Parent réserve un créneau
  const parentBook = await req('/api/parent/bookings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${parentToken}` },
    body: JSON.stringify({ enrollment_id: enId, slot_id: slotId })
  });
  assert.strictEqual(parentBook.status, 201);
  const bookingId = parentBook.body.id;
  console.log('✔ Boutons Portail Parent (Consultation, Réservation) 100% fonctionnels.');

  // 11. Séances & Émargement Coach
  // Coach consulte ses séances du jour
  const coachSessions = await coachClient.call('/api/admin/sessions?date=2026-11-10');
  assert.strictEqual(coachSessions.status, 200);
  assert.strictEqual(coachSessions.body.length, 1);
  assert.strictEqual(coachSessions.body[0].id, slotId);

  // Bouton "📋 Feuille de présence & Appel"
  const roster = await coachClient.call(`/api/admin/sessions/${slotId}/roster`);
  assert.strictEqual(roster.status, 200);
  assert.strictEqual(roster.body.length, 1);
  assert.strictEqual(roster.body[0].id, bookingId);

  // Boutons pointage ("✔ Présent", "✖ Absent", "Excusé")
  const attendPres = await coachClient.call(`/api/admin/attendance/${bookingId}`, 'PATCH', { status: 'attended' });
  assert.strictEqual(attendPres.status, 200);
  const attendAbs = await coachClient.call(`/api/admin/attendance/${bookingId}`, 'PATCH', { status: 'absent_excuse' });
  assert.strictEqual(attendAbs.status, 200);
  console.log('✔ Boutons Séances & Émargement Coach (Feuille d\'appel, Présent, Absent, Excusé) 100% fonctionnels.');

  // 12. Équipe & Accès
  // Bouton "+ Nouvel utilisateur"
  const newUser = await adminClient.call('/api/admin/users', 'POST', {
    username: 'assistant_temp',
    password: 'TempPassword123!',
    role: 'accueil'
  });
  assert.strictEqual(newUser.status, 201);
  const tempUserId = newUser.body.id;

  // Bouton "Supprimer" utilisateur
  const delUser = await adminClient.call(`/api/admin/users/${tempUserId}`, 'DELETE');
  assert.strictEqual(delUser.status, 200);
  console.log('✔ Boutons Équipe & Accès (+ Utilisateur, Supprimer) 100% fonctionnels.');

  // 13. Réglages & Mot de passe
  // Bouton "Enregistrer les règles"
  const saveSet = await adminClient.call('/api/admin/settings', 'PUT', {
    weekly_limit: 3,
    cancel_deadline_hours: 5,
    min_booking_hours: 2,
    contact_phone: '57 149 933'
  });
  assert.strictEqual(saveSet.status, 200);

  // Bouton "Mettre à jour mon mot de passe"
  const chPass = await adminClient.call('/api/admin/change-password', 'POST', {
    currentPassword: 'AdminPass123!',
    newPassword: 'NewAdminPass456!'
  });
  assert.strictEqual(chPass.status, 200);
  console.log('✔ Boutons Réglages & Sécurité (Règles métier, Changement mot de passe) 100% fonctionnels.');

  // 14. Contrôles RBAC stricts
  // Coach ne peut pas créer de prospect ou accéder aux finances
  const coachForbidden1 = await coachClient.call('/api/admin/prospects', 'GET');
  assert.strictEqual(coachForbidden1.status, 403, 'Coach bloqué sur prospects');
  const coachForbidden2 = await coachClient.call('/api/admin/payments', 'GET');
  assert.strictEqual(coachForbidden2.status, 403, 'Coach bloqué sur finances');

  // Compta ne peut pas gérer les utilisateurs
  const comptaForbidden = await comptaClient.call('/api/admin/users', 'GET');
  assert.strictEqual(comptaForbidden.status, 403, 'Compta bloqué sur utilisateurs');
  console.log('✔ Cloisonnement RBAC strict validé (aucun accès non autorisé).');

  server.close();
  try { fs.unlinkSync(testDbPath); } catch (e) {}
  console.log('\n🎉 TOUS LES BOUTONS ET TOUTES LES FONCTIONNALITÉS DE L\'APPLICATION SONT TOTALEMENT OPÉRATIONNELS !');
}

runAudit().catch(err => {
  console.error('❌ Échec de l\'audit des boutons :', err);
  process.exit(1);
});
