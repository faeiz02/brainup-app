require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const cookieSession = require('cookie-session');

const { db } = require('./database/db');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3002;
const isProduction = process.env.NODE_ENV === 'production';

// Nécessaire pour que req.ip et le rate-limiting fonctionnent correctement
// derrière un proxy inverse (Railway, Render, Nginx...)
app.set('trust proxy', 1);

// --- Vérification du secret de session ---
const DEFAULT_SECRET = 'change-this-secret-in-production';
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET === DEFAULT_SECRET) {
  if (isProduction) {
    // En production, on refuse de démarrer avec un secret par défaut/absent :
    // mieux vaut un crash explicite qu'une faille de sécurité silencieuse.
    console.error('\n❌ ERREUR : SESSION_SECRET manquant ou par défaut en production.');
    console.error('   Définissez une valeur longue et aléatoire dans les variables d\'environnement.');
    console.error('   Exemple pour en générer une : node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n');
    process.exit(1);
  } else {
    // En développement, on génère un secret temporaire pour ne pas bloquer,
    // mais on avertit clairement.
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('\n⚠️  SESSION_SECRET non défini : un secret temporaire a été généré pour le développement.');
    console.warn('   Les sessions seront invalidées à chaque redémarrage. Définissez SESSION_SECRET dans .env.\n');
  }
}

// --- En-têtes de sécurité HTTP ---
app.use(helmet({
  // Le site sert du JS inline dans ses pages ; une CSP stricte nécessiterait
  // une refonte en fichiers .js séparés avec nonce. On garde les autres
  // protections de helmet (X-Frame-Options, X-Content-Type-Options, HSTS...) actives.
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// --- Redirection forcée vers HTTPS en production ---
app.use((req, res, next) => {
  if (isProduction && req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

app.use(express.json());
app.use(cookieSession({
  name: 'brainup_session',
  secret: SESSION_SECRET,
  maxAge: 12 * 60 * 60 * 1000, // 12h — durée réduite par rapport aux 24h initiales
  httpOnly: true,          // inaccessible en JavaScript côté navigateur
  sameSite: 'strict',      // empêche l'envoi du cookie depuis un autre site (protection CSRF)
  secure: isProduction,    // cookie transmis uniquement en HTTPS en production
}));

// API
app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);

// Static files (public site + admin panel)
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallbacks
app.get('/admin*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🧠 Brain Up server running → http://localhost:${PORT}`);
  console.log(`   Admin panel        → http://localhost:${PORT}/admin`);
});
