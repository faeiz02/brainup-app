# Brain Up — Site de réservation + Administration

Application complète de réservation de séances (robotique, jeux vidéo…) avec
un vrai backend, une base de données SQLite, et un panneau d'administration
pour tout gérer sans toucher au code.

## Ce que contient le projet

```
brainup-app/
├── server.js              → serveur Express (API + fichiers statiques)
├── database/
│   ├── db.js               → schéma SQLite (créé automatiquement)
│   ├── seed.js              → données de démonstration + compte admin
│   └── brainup.db           → la base de données (déjà pré-remplie)
├── routes/
│   ├── public.js            → API publique (villes, modules, créneaux, réservations)
│   └── admin.js             → API admin (CRUD complet + authentification)
├── middleware/auth.js       → protection des routes admin
├── public/
│   ├── index.html            → le site de réservation (public)
│   ├── admin/index.html      → le panneau d'administration
│   └── assets/                → logo et favicons
├── .env.example
└── package.json
```

## 1. Lancer le site en local

Prérequis : [Node.js](https://nodejs.org) version 18 ou plus.

```bash
cd brainup-app
npm install
cp .env.example .env      # puis modifiez les valeurs si besoin
npm start
```

Le site est accessible sur **http://localhost:3000**
Le panneau admin est sur **http://localhost:3000/admin**

La base de données est déjà pré-remplie (villes, règlement, un module de
démonstration à Nabeul). Si vous voulez repartir de zéro :

```bash
rm database/brainup.db
npm run seed
```

### Identifiants admin par défaut

```
Identifiant : admin
Mot de passe : BrainUp2026!
```

⚠️ **Changez ce mot de passe dès la première connexion** (Admin → Réglages
& compte → "Changer mon mot de passe"), ou définissez `ADMIN_PASSWORD` dans
`.env` **avant** le tout premier lancement de `npm run seed`.

## 2. Ce que permet le panneau d'administration

- **Tableau de bord** : statistiques (réservations, villes, modules, créneaux à venir)
- **Réservations** : liste complète, recherche, filtre par statut, changement de
  statut (confirmée / présent / absent / annulée), suppression, **export CSV**
- **Villes** : ajouter / modifier / désactiver / supprimer un espace de formation
- **Modules** : ajouter / modifier les ateliers (titre, description, tranche
  d'âge, durée, jour habituel)
- **Créneaux** : ajout ponctuel, ou **génération en masse** (ex : "tous les
  dimanches à 15h30 du 1er au 30 septembre")
- **Annonces** : gérer le contenu affiché à l'étape "Nouveautés"
- **Règlement intérieur** : modifier les règles affichées avant réservation
- **Réglages & compte** : nom du site, téléphone de contact, mot de passe admin

Toutes les modifications faites dans l'admin sont **immédiatement reflétées**
sur le site public (les villes, modules, créneaux, règles et annonces ne sont
plus codés en dur, ils viennent de la base de données).

## 3. Héberger le site (mise en production)

C'est une application **Node.js classique avec base de données SQLite locale**
(un simple fichier `.db`, pas besoin de serveur de base de données séparé).
Cela fonctionne sur n'importe quel hébergeur qui exécute du Node.js **avec un
disque persistant** (important : le fichier `.db` doit survivre aux redéploiements).

### Option recommandée : Railway ou Render (gratuit pour démarrer)

**Railway** (https://railway.app) :
1. Crée un compte, "New Project" → "Deploy from GitHub repo" (ou "Empty
   project" puis upload du dossier)
2. Railway détecte automatiquement Node.js (`npm install` puis `npm start`)
3. Dans l'onglet **Variables**, ajoute :
   - `SESSION_SECRET` → une longue chaîne aléatoire
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD` → tes identifiants souhaités
4. Dans l'onglet **Settings → Volumes**, ajoute un volume monté sur
   `/app/database` (pour que la base de données SQLite ne soit pas effacée à
   chaque redéploiement)
5. Railway te donne une URL publique (`https://xxxx.up.railway.app`) — tu
   peux ensuite brancher ton propre nom de domaine dans Settings → Domains.

**Render** (https://render.com) : même principe — "New Web Service", build
command `npm install`, start command `npm start`, et un **disque persistant**
(Render → "Disks") monté sur `/opt/render/project/src/database`.

### Option VPS classique (OVH, Contabo, DigitalOcean…)

```bash
# Sur le serveur
git clone <ton-dépôt>   # ou upload du dossier via SFTP
cd brainup-app
npm install --production
cp .env.example .env    # remplis les vraies valeurs
npm run seed             # une seule fois, pour créer la base initiale

# Garder le serveur actif en permanence :
npm install -g pm2
pm2 start server.js --name brainup
pm2 save
pm2 startup              # pour redémarrer automatiquement au reboot du serveur
```

Ensuite, mets un reverse proxy **Nginx** devant (port 80/443 → port 3000) et
un certificat SSL gratuit avec **Certbot** (Let's Encrypt) pour le HTTPS.

### ⚠️ Point important : SQLite et hébergeurs "sans disque persistant"

Des plateformes comme **Vercel** ou **Netlify** ne conviennent **pas** ici,
car elles ne fournissent pas de disque persistant pour les fonctions
serverless — la base SQLite serait effacée à chaque déploiement. Utilise
Railway, Render, un VPS, ou tout hébergeur avec un vrai disque
persistant. Si tu veux absolument du serverless, il faudrait migrer la base
vers un service de BDD hébergé (PostgreSQL sur Supabase/Neon par exemple) —
dis-le si tu veux cette variante.

## 4. Variables d'environnement (`.env`)

| Variable | Description | Défaut |
|---|---|---|
| `PORT` | Port d'écoute du serveur | `3000` |
| `SESSION_SECRET` | Clé secrète pour signer les sessions admin (⚠️ à changer en prod) | — |
| `ADMIN_USERNAME` | Identifiant admin créé au premier `npm run seed` | `admin` |
| `ADMIN_PASSWORD` | Mot de passe admin créé au premier `npm run seed` | `BrainUp2026!` |
| `DB_PATH` | Emplacement du fichier de base de données | `./database/brainup.db` |

## 5. Sauvegarder la base de données

Le fichier `database/brainup.db` contient **toutes** les données (villes,
modules, créneaux, réservations, annonces, règlement, compte admin). Pour
sauvegarder : copie simplement ce fichier ailleurs (ou programme une copie
automatique quotidienne via cron sur ton serveur).

## 6. Sécurité de l'authentification admin

Le système d'authentification applique les protections suivantes, activées
par défaut :

| Protection | Détail |
|---|---|
| **Mot de passe haché** | `bcrypt`, coût 12 — jamais stocké en clair |
| **Changement de mot de passe obligatoire** | Bloqué à la 1ʳᵉ connexion tant que le mot de passe par défaut n'a pas été changé (vérifié aussi côté serveur, pas juste à l'écran) |
| **Verrouillage anti force-brute** | 5 échecs → compte verrouillé 15 minutes |
| **Limite de débit par IP** | Max 20 tentatives / 15 min sur `/api/admin/login`, tous comptes confondus |
| **Messages d'erreur génériques** | "Identifiants incorrects" que le compte existe ou non, pour empêcher l'énumération de comptes |
| **Journal des connexions** | Historique des 50 dernières tentatives (réussies/échouées, IP, date) visible dans Admin → Réglages |
| **Cookies de session sécurisés** | `httpOnly` (invisible en JS), `sameSite=strict` (anti-CSRF), `Secure` (HTTPS uniquement) en production |
| **Régénération de session** | Un nouvel identifiant de session est généré à chaque connexion (anti session-fixation) |
| **En-têtes de sécurité HTTP** | `helmet` : `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`, etc. |
| **Redirection HTTPS forcée** | En production, toute requête HTTP est redirigée vers HTTPS |
| **Secret de session vérifié au démarrage** | Le serveur refuse de démarrer en production sans `SESSION_SECRET` défini |

### Générer un `SESSION_SECRET` sûr

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Colle le résultat dans la variable d'environnement `SESSION_SECRET` (fichier
`.env` en local, ou variables d'environnement de ton hébergeur en production).

## 7. Checklist avant mise en ligne publique

- [ ] `NODE_ENV=production` défini sur l'hébergeur (active HTTPS forcé + cookies sécurisés)
- [ ] `SESSION_SECRET` généré aléatoirement (voir commande ci-dessus)
- [ ] Mot de passe admin changé (imposé automatiquement à la 1ʳᵉ connexion)
- [ ] Volume/disque persistant configuré pour `database/`
- [ ] `.env` non commité dans un dépôt public (déjà exclu par `.gitignore`)
- [ ] Sauvegarde régulière de `database/brainup.db` programmée
