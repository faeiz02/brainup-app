require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const CITIES = [
  { name: 'Lac 1', slug: 'lac-1' },
  { name: 'Nabeul', slug: 'nabeul', is_new: 1 },
  { name: 'Sfax Route Tunis', slug: 'sfax-route-tunis' },
  { name: 'Sousse Sahloul', slug: 'sousse-sahloul' },
  { name: 'Menzah 6', slug: 'menzah-6' },
  { name: 'Sousse Trocadéro', slug: 'sousse-trocadero' },
  { name: 'Denden', slug: 'denden' },
  { name: 'Sfax Nasria', slug: 'sfax-nasria' },
  { name: 'El Mourouj 6', slug: 'el-mourouj-6' },
  { name: 'La Manouba', slug: 'la-manouba' },
  { name: 'Ariana Ville', slug: 'ariana-ville' },
  { name: 'Boumhel', slug: 'boumhel' },
];

const RULES = [
  { icon: 'book', body: "Le respect du règlement intérieur au niveau de l'espace de formation et de l'immeuble est obligatoire pour tous." },
  { icon: 'edit', body: "La présence doit être cochée sur la tablette à l'entrée et à la sortie par le parent ou l'accompagnant, sinon, l'élève sera considéré comme absent." },
  { icon: 'userCheck', body: "Les parents (ou les accompagnants) sont tenus d'accompagner leurs enfants jusqu'à la porte d'entrée de l'espace de formation Brain Up et de les y récupérer à l'heure exacte de la fin de la séance." },
  { icon: 'calendar', body: "Il est possible de réserver 2 séances maximum par semaine, et une seule par jour." },
  { icon: 'users', body: "Chaque élève est considéré comme mineur et doit obligatoirement être accompagné d'un adulte responsable." },
  { icon: 'alert', body: "L'entreprise Brain Up Innovation SARL décline toute responsabilité quant aux incidents pouvant survenir en dehors de son espace de formation, notamment en cas de négligence ou d'absence de surveillance de la part des parents ou des accompagnants." },
  { icon: 'laptop', body: "Chaque parent peut faire une demande de bilan d'apprentissage et de compétences de son enfant (tous les 2 mois) via notre plateforme : https://suivi.brainup.tech" },
  { icon: 'clock', body: "La ponctualité est primordiale pour le bon déroulement des séances." },
  { icon: 'ban', body: "Les parents (ou les accompagnants) ne sont pas autorisés à attendre leurs enfants dans l'espace de formation ni dans l'immeuble." },
  { icon: 'calendar', body: "Toute annulation doit être effectuée au minimum 5 heures avant le début de la séance, sinon elle sera considérée comme une absence. Au bout de 2 absences par mois, il ne sera plus possible de réserver que le mois suivant." },
];

const ANNOUNCEMENTS = [
  { title: 'Le portail des parents', body: "Suivez nos actualités et informations importantes : https://info.brainup.tech" },
  { title: "Demandez le bilan d'apprentissage de votre enfant", body: "Envoyez votre demande de suivi via notre plateforme (tous les 2 mois) : https://suivi.brainup.tech" },
  { title: 'Pôle Relation Parents', body: "Un numéro unique est à votre disposition pour toutes vos demandes ou questions : 57 149 933" },
];

function run() {
  const cityCount = db.prepare('SELECT COUNT(*) c FROM cities').get().c;
  if (cityCount === 0) {
    const insertCity = db.prepare(`INSERT INTO cities (name, slug, address, maps_url, is_new, sort_order) VALUES (?,?,?,?,?,?)`);
    CITIES.forEach((c, i) => {
      insertCity.run(c.name, c.slug, c.address || `Avenue principale, ${c.name}`, c.maps_url || `https://maps.google.com/?q=${encodeURIComponent(c.name)}`, c.is_new || 0, i);
    });
    console.log(`✔ ${CITIES.length} villes ajoutées`);

    const nabeul = db.prepare('SELECT id FROM cities WHERE slug = ?').get('nabeul');
    const insertModule = db.prepare(`
      INSERT INTO modules (city_id, title, description, icon, age_group, day_label, duration_minutes, sort_order)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    const roboId = insertModule.run(nabeul.id, 'Robotique Intelligente', 'Construisez et programmez des robots intelligents.', 'robot', '7-12', 'Samedi', 90, 0).lastInsertRowid;
    const jvId = insertModule.run(nabeul.id, 'Développement des jeux vidéo', 'Développez vos propres jeux vidéo 2D et 3D.', 'gamepad', '7-12', 'Dimanche', 90, 1).lastInsertRowid;
    console.log('✔ 2 modules ajoutés pour Nabeul');

    // A demo slot for the video game module (matches the original screenshots)
    const insertSlot = db.prepare(`INSERT INTO slots (module_id, date, time, capacity) VALUES (?,?,?,?)`);
    insertSlot.run(jvId, '2026-09-06', '15:30', 20);
    insertSlot.run(jvId, '2026-09-13', '15:30', 20);
    insertSlot.run(jvId, '2026-09-20', '15:30', 20);
    insertSlot.run(roboId, '2026-09-05', '10:00', 20);
    insertSlot.run(roboId, '2026-09-12', '10:00', 20);
    console.log('✔ créneaux de démonstration ajoutés');
  } else {
    console.log('… des villes existent déjà, seed des villes/modules ignoré');
  }

  const ruleCount = db.prepare('SELECT COUNT(*) c FROM rules').get().c;
  if (ruleCount === 0) {
    const insertRule = db.prepare(`INSERT INTO rules (icon, body, sort_order) VALUES (?,?,?)`);
    RULES.forEach((r, i) => insertRule.run(r.icon, r.body, i));
    console.log(`✔ ${RULES.length} règles ajoutées`);
  }

  const annCount = db.prepare('SELECT COUNT(*) c FROM announcements').get().c;
  if (annCount === 0) {
    const insertAnn = db.prepare(`INSERT INTO announcements (title, body, sort_order) VALUES (?,?,?)`);
    ANNOUNCEMENTS.forEach((a, i) => insertAnn.run(a.title, a.body, i));
    console.log(`✔ ${ANNOUNCEMENTS.length} annonces ajoutées`);
  }

  const adminCount = db.prepare('SELECT COUNT(*) c FROM admin_users').get().c;
  if (adminCount === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'BrainUp2026!';
    const hash = bcrypt.hashSync(password, 12);
    db.prepare('INSERT INTO admin_users (username, password_hash, must_change_password) VALUES (?,?,1)').run(username, hash);
    console.log(`✔ compte admin créé → identifiant: "${username}" / mot de passe: "${password}"`);
    console.log('⚠️  Un changement de mot de passe sera exigé automatiquement à la première connexion.');
  }

  const settingsDefaults = {
    site_name: 'Brain Up',
    contact_phone: '57 149 933',
    max_absences_per_month: '2',
  };
  const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)`);
  Object.entries(settingsDefaults).forEach(([k, v]) => insertSetting.run(k, v));

  console.log('\nSeed terminé.');
}

run();
