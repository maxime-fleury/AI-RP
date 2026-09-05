# Innsekai — Roleplay & Mondes

Interface web de roleplay avec IA : crée des mondes (isekai…), importe des
cartes de personnages SillyTavern, définis des scénarios et **joue** avec un
narrateur + des personnages — en solo ou en groupe — avec des **illustrations
générées** (Koji / SDXL) et une boîte à outils narrative complète.

> Le cœur du système est un prompt RP **en couches** : règles dures →
> données → style → mémoire → pilotage. Les règles critiques (agentivité du
> joueur, focus de scène) sont répétées juste avant la génération, un
> **garde-fou post-génération** détecte les dérives, et les fonctionnalités
> avancées restent disponibles mais ne polluent plus le chemin par défaut.
> Voir [Architecture RP](#architecture-rp) plus bas.

## Démarrage

Prérequis : [Bun](https://bun.sh) ≥ 1.1, et un fournisseur d'IA —
[LM Studio](https://lmstudio.ai) (local) ou une clé OpenRouter.

```bash
bun install

# 1. Fournisseur : soit LM Studio (API locale), soit OpenRouter (cloud).
#    → configurable ensuite dans l'app : Réglages ⚙️ → IA
# 2. Serveur de l'app
PORT=3210 bun src/index.ts
# → http://localhost:3210  (port auto 3000→3600 si PORT absent)
```

- Les **images** démarrent un sidecar Python (Koji) automatiquement à la
  première génération — voir [Images](#images).
- Variables d'environnement : `PORT` (port HTTP), `INNSEKAI_DATA_DIR`
  (déplacer les données hors du dépôt), `INNSEKAI_PROMPT_DIR` (racine des
  fichiers de prompts, pour les tests).

## Scripts utiles

| Commande | Rôle |
| --- | --- |
| `bun src/index.ts` | Serveur de l'app (API + SPA) |
| `bun run check` | Typecheck + build + **tests** (242 tests) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | Tests unitaires |
| `bun scripts/test-api.ts` | Test d'intégration API de bout en bout |
| `bun scripts/mock-lmstudio.ts` | Faux LM Studio offline (tests du chat) |
| `python python/image_server/server.py` | Sidecar images Koji |

## Fonctionnalités

### Roleplay

- **Profils de conversation** par partie : comportement (`réactif` — suit le
  joueur, `équilibré` — par défaut, `cinématique` — initiative narrative),
  **longueur de réponse** (courte/moyenne/longue) et **mode de contexte**
  (Simple = essentiel / Avancé = toutes les mémoires).
- **Détection automatique d'intention** à chaque tour (conversation, romance,
  combat, enquête, exploration, tranche de vie…) : le focus de scène suit
  l'action du joueur, et si celui-ci **change de direction** (il abandonne une
  quête pour une scène calme), le plan de scène persistant est mis en veille
  pour ce tour.
- **Focus de scène explicite** (override manuel) : Explorer, Conversation,
  Romance/intimité, Scène adulte, Combat, Enquête, Tranche de vie, Focus
  personnage — ou **Auto**.
- **Canal de pilotage par tour** : une consigne courte (« reste concentré sur
  cette conversation ») envoyée avec le message, prioritaire sur tout le reste.
- **Hors-jeu (OOC)** : `/ooc …` sort de la fiction — réponse hors narrateur.
- **Garde-fou post-génération** : vérifie après coup que la réponse n'a pas
  fait agir/parler le joueur à sa place ni introduit d'événement majeur non
  demandé ; régénère une fois en rappelant la contrainte si nécessaire.
- **Suggestions de réponses** (« chips » 💡) après chaque tour.
- Interpellations : « Fais répondre Alba » — le narrateur ou un personnage
  précis peut parler, sans re-rôle de toute la scène.
- **Presets du narrateur** éditables (Épique, Sarcastique, Cynique, En colère,
  Nagatoro-taquin…) + presets personnalisés, modifiables dans les Réglages.

### Mémoire & narration (outils par partie)

- **Mémoire structurée unifiée** : résumé glissant, chapitres, récapitulatif
  de session, lorebook et mémoire de boucles temporelles sont fusionnés en un
  seul bloc « mémoire pertinente » sélectionné par similarité à chaque tour
  (le déclenchement du lorebook réagit au message courant, sans délai).
- **Résumés glissants** automatiques quand le contexte déborde (mode Simple).
- **Memory Center** 🧠 : panneaux Mémoire, Canon, Relations, Lore de la partie.
- **Canon joueur** : faits verrouillés 🔒 (jamais contredits) + propositions IA
  à valider.
- **Chapitres** automatiques + **PNJ dynamiques** proposés par l'IA (à
  valider), **journal de quêtes**, **graphe des relations** 💞 (affinités entre
  personnages qui évoluent), **stats de partie**.
- **« Previously on… »** : récap de session avec storyboard d'images à la
  reprise.
- **Boucles temporelles** (moteur façon Re:Zero) : checkpoints, retour en
  arrière, mémoire de boucles — opt-in par partie.

### Questionnaire du meneur ❓

« Poser des questions » dans le menu ⋮ d'une partie : le narrateur prépare des
questions (ancrées dans le monde, le casting et la mémoire), l'utilisateur
répond en choisissant des réponses suggérées ou en écrivant la sienne, et les
réponses sont renvoyées dans l'histoire comme un tour normal.

### Images

- Sidecar Python Koji (SDXL / SD 1.5) : illustrations de scène en tags
  danbooru (FR→EN) avec prompt négatif complet.
- **Cohérence visuelle** : img2img depuis le portrait de la carte (fidélité
  réglable) pour garder un personnage stable d'une scène à l'autre.
- Scènes de décor détectées en format paysage, seed affiché, bouton
  « Variante », avatars IA pour les cartes/personas, jaquette de monde,
  carte du monde, galerie avec légendes écrites par l'IA.

### Contexte & transport

- Fournisseurs **LM Studio** (streaming local) et **OpenRouter** (cloud),
  température, budget tokens, `noThinking` selon le fournisseur, retries avec
  backoff, timeout réglable.
- Budget de prompt **adapté à la taille du modèle** (petit ≈ 4k tokens,
  moyen ≈ 8k, grand ≈ 12k, surchargeables dans les Réglages) — la troncature
  coupe d'abord la mémoire/le style, jamais les règles ni le pilotage.
- **Inspecteur de contexte** + traces de diagnostic par message (comportement,
  focus, source du focus, modèle, budget, garde-fou) — visibles dans le
  contexte d'une partie.

## Fichiers de prompts (modifiable sans code)

Tous les prompts envoyés aux modèles vivent dans [`prompt/`](prompt/) —
`prompt/fr/<id>.txt`, traductions en `prompt/en/`. Éditer un prompt est un
changement de contenu, pas de code. Le compilateur RP en couches
(`src/llm/prompt.ts`) reste volontairement en code (ordre des couches +
troncature par budget) — voir `prompt/README.md`.

## Sauvegarde & données

- **Réglages → Sauvegarde** : export/restauration JSON complète (mondes,
  scénarios, cartes, personas, conversations, réglages) avec les médias.
- **Backup SQLite automatique quotidien** (`data/backups/`, rotation 7 jours),
  états du disque, restauration transactionnelle.
- `data/` contient la base SQLite et les fichiers générés ; `INNSEKAI_DATA_DIR`
  le déplace ailleurs.

## Sécurité

- **Token d'accès LAN optionnel** (`auth_token`) exigé sur toutes les routes
  API quand il est configuré.
- Uploads plafonnés (taille, nombre, types), chemins contrôlés
  (anti zip-slip), clés API jamais renvoyées au client (flag `_set`).

## Architecture RP

Le système de prompt suit le plan de refonte « roleplay réactif » :

1. **Compilateur en couches** — le prompt est assemblé dans l'ordre
   `règles dures → données → style → mémoire → pilotage` ; les données
   (monde, fiches, canon) sont marquées `[DONNÉES]` pour être traitées comme
   contexte, jamais comme instructions.
2. **Profils + détection d'intention** — le dernier message contrôle la scène
   locale ; un changement de direction net met le plan de scène en veille pour
   ce tour (le menu manuel reste un override prioritaire).
3. **Budget par modèle** — le contexte Simple n'emporte que l'essentiel et les
   tours récents ; la troncature préserve les règles et le pilotage.
4. **Garde-fou post-génération** — vérification par règles après le stream ;
   régénération corrective transparente en cas de dérive.
5. **Télémétrie** — traces par tour (métriques JSONL dans `data/metrics.jsonl`)
   et résumé affiché dans Réglages → 📊 Métriques RP.

## Structure

```
prompt/                    fichiers de prompts (fr/, en/) — éditables
public/                    SPA (HTML/CSS/JS vanilla)
src/index.ts               serveur HTTP (fichiers statiques + API)
src/server/                db, routes par ressource, jobs, logs, image
src/server/routes/         index (dispatch) + worlds/cards/personas/
                           conversations/stream/messages/media/jobs/
                           settings/backups/assist + core (helpers)
src/llm/                   providers, prompt RP en couches, promptText,
                           intent (classifieur), guardrail, mémoire
src/shared/                types partagés client/serveur (contrats)
python/image_server/       sidecar images (diffusers + Koji)
models/                    modèles locaux (images)
tests/                     242 tests (unitaires + comportement RP)
```

## Développement

- **Typecheck** : `bun run check` (typecheck + build + tests).
- Le typecheck couvre aussi `public/js/api.js` (`// @ts-check`) contre les
  contrats partagés `src/shared/contracts.ts`.
- Les assets sont servis avec `ETag`/`Last-Modified` (304) — **pas** de cache
  buster `?v=` (un garde CI l'interdit).
- Migration de schéma : `PRAGMA user_version` + `runMigrations()` dans
  `src/server/db.ts` — bump `SCHEMA_VERSION` et ajoute une étape, jamais
  d'ALTER inline.
