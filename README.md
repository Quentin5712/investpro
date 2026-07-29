# InvestPro — Serveur Backend

## Stack
- Node.js + Express
- JSONBin.io (base de données)

## Variables d'environnement (Render.com)

| Variable   | Valeur                                                      |
|------------|-------------------------------------------------------------|
| BIN_ID     | 6a4cdd5cf5f4af5e296bb50b                                   |
| API_KEY    | $2a$10$WiRdDM1vwwyaoA.yf/.XkuA/2173q1VIdQ56RJyfD4vGgp8U5tu.O |
| ADMIN_KEY  | investpro_admin_secret_2024                                 |
| PORT       | (automatique sur Render)                                    |

## Déploiement sur Render.com

1. Créer un compte sur render.com
2. New → Web Service → Connect GitHub
3. Sélectionner le repo
4. Build Command : npm install
5. Start Command : node server.js
6. Ajouter les variables d'environnement ci-dessus
7. Deploy !

## Routes API

### Utilisateurs
- POST /api/register
- POST /api/login
- POST /api/user/save
- GET  /api/user?email=xxx

### Transactions
- POST /api/deposit
- POST /api/withdraw

### Admin
- GET  /api/admin/data
- POST /api/admin/deposit/approve
- POST /api/admin/deposit/reject
- POST /api/admin/withdraw/approve
- POST /api/admin/withdraw/reject
- POST /api/admin/invest/approve
- POST /api/admin/user/delete
- POST /api/admin/site
- POST /api/admin/notifs/read
- POST /api/admin/sms-verify

### Utilitaires
- GET  /api/ping
- GET  /sms-listener

## Test après déploiement
Visitez : https://votre-app.onrender.com/api/ping
Réponse attendue : {"ok":true,"msg":"InvestPro API OK"}

## UptimeRobot (éviter l'endormissement)
Configurer un monitor HTTP sur https://votre-app.onrender.com/api/ping
Interval : 5 minutes
