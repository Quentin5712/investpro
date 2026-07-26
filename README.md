# InvestPro — Serveur Backend

## Variables d'environnement (à configurer sur Render.com)

| Variable  | Valeur                                      |
|-----------|---------------------------------------------|
| BIN_ID    | 6a4cdd5cf5f4af5e296bb50b                   |
| API_KEY   | $2a$10$WiRdDM1vwwyaoA.yf/.XkuA/2173q1...  |
| PORT      | (automatique sur Render)                    |

## Déploiement sur Render.com

1. Crée un compte sur render.com
2. New → Web Service
3. Connect GitHub (upload ce dossier)
4. Build Command: (vide)
5. Start Command: node server.js
6. Ajoute les variables d'environnement
7. Deploy !

## Routes API

- POST /api/register
- POST /api/login
- POST /api/user/save
- POST /api/deposit
- POST /api/withdraw
- GET  /api/admin/data
- POST /api/admin/deposit/approve
- POST /api/admin/deposit/reject
- POST /api/admin/withdraw/approve
- POST /api/admin/withdraw/reject
- POST /api/admin/invest/approve
- POST /api/admin/user/delete
- POST /api/admin/site
- POST /api/admin/notifs/read
