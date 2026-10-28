# eMajlis API (CSEFRS)

API Express qui relaie l'application mobile vers HumHub (API REST v1) et vers
l'intranet WordPress. Les permissions sont toujours décidées par HumHub, avec le
jeton de l'utilisateur.

## Lancer en local

```bash
npm install
cp .env.example .env
npm run dev
```

## Déploiement (Railway)

Railway construit l'image avec le `Dockerfile` (Node 20, LibreOffice, Ghostscript,
polices arabes).

Variables à définir sur Railway :

| Variable | Rôle |
|---|---|
| `HUMHUB_BASE_URL` | Adresse HumHub |
| `WP_BASE_URL`, `WP_USER`, `WP_APP_PASSWORD` | Intranet WordPress (Journal, revues de presse). L'intranet exige une connexion : créez un compte en lecture seule et un *mot de passe d'application* (Profil → Mots de passe d'application). |
| `PUSH_SECRET` | Chaîne aléatoire longue : chiffre les inscriptions push sur disque |
| `PUBLIC_BASE_URL` | Adresse publique de l'API (facultatif) |

**Volume** : montez un volume Railway sur `/app/data`. Il conserve les inscriptions
push et les miniatures entre deux déploiements.

## Points d'entrée ajoutés

| Route | Rôle |
|---|---|
| `POST /api/files/ticket` | Lien de lecture temporaire (15 min, identifiant opaque) |
| `GET /api/files/view/:ticket[?as=pdf]` | Fichier en ligne ; `as=pdf` convertit Word/Excel/PowerPoint |
| `GET /api/thumbs/:source/:id` | Miniature (`drive` ou `cfile`) ; 202 tant qu'elle est en cours |
| `POST / DELETE /api/push/register` | Inscription d'un appareil aux notifications (Expo) |
| `GET /api/content/:id?title=` | Détail ; articles et revues de presse en HTML complet |
