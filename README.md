# AI-RP — Roleplay & Mondes

Interface web de roleplay avec IA : crée des mondes (isekai…), importe des cartes
de personnages SillyTavern, définis des scénarios et joue avec un narrateur + des
personnages — le tout avec des **illustrations générées** (Koji / SDXL).

## Démarrage

```bash
# 1. Lancer l'API compatible OpenAI (LM Studio sur http://172.17.240.1:3007/v1, par ex.)
# 2. Lancer le serveur de l'app
PORT=3210 bun src/index.ts
# → http://localhost:3210
```

- Le port est choisi par `PORT` (sinon 3000→3600 automatiquement).
- L'URL de LM Studio et le modèle se règlent dans **Réglages** (⚙️) de l'app.
- Le serveur d'images (Koji) se lance automatiquement à la première demande.

## Scripts utiles

| Commande | Rôle |
| --- | --- |
| `bun src/index.ts` | Serveur de l'app (API + SPA) |
| `bun test` | Tests unitaires (routage, prompt, import, stockage) |
| `bun run check` | Build + tests (CI locale) |
| `bun scripts/test-api.ts` | Test d'intégration API de bout en bout |
| `python python/image_server/server.py --port 8770` | Sidecar images Koji |

## Sauvegarde

- **Réglages → Sauvegarde** : « ⬇️ Exporter tout » télécharge un JSON complet
  (mondes, scénarios, cartes, personas, conversations) ; « ⬆️ Restaurer »
  recrée tout depuis un fichier.
- Le dossier `data/` contient la base SQLite et tous les fichiers générés
  (images) : copie-le régulièrement pour tout conserver, ou ajoute
  `AI_RP_DATA_DIR` comme variable d'environnement pour déplacer ces données
  ailleurs.

## Stack

- **Serveur** : Bun + TypeScript, SQLite (`data/app.db`), SSE pour le streaming.
- **Chat** : LM Studio (local) ou OpenRouter, prompt RP (narrateur + personnages),
  mode solo ou groupe, suggestions de réponses (« chips » 💡), boutons
  « Faire parler » (narrateur ou un personnage précis), presets de style du
  narrateur (Épique, Sarcastique, Cynique, En colère, Nagatoro…), panneau
  latéral réductible, commandes slash (`/dice 2d6`, `/ooc`, `/narrate`, `/card`),
  recherche dans le fil, export Markdown, édition des messages au double-clic.
- **Images** : Koji v2.1 (SD 1.5) via sidecar Python (diffusers + torch CUDA),
  illustrations de scène en prompt style tags danbooru (FR→EN) + négatif complet ;
  les scènes de décor sont détectées et générées en format paysage (seed affiché,
  bouton « Variante »). Pré-chargement du modèle au démarrage en option.
- **Front** : SPA vanilla, deux thèmes (glassmorphism néon / anime vibrant),
  import de cartes PNG+JSON (spec SillyTavern V1/V2).
- **Aide IA pour les cartes** : dans la fenêtre de création de personnage, décris
  ton idée en quelques mots — l'IA propose des chips pour chaque champ (nom,
  description, personnalité, premier message, tags…) et tu choisis tes préférées
  d'un clic.
- **Quality of life** : bouton ⏹ Stop pendant la génération (le partiel est
  conservé), autocomplétion des slash commands (menu type Discord), réactions
  émoji 👍❤️😂, notifications quand l'onglet est en arrière-plan, parties
  épinglées ⭐ + corbeille (archive/restaure/supprime définitivement),
  estimation des tokens du contexte dans les réglages de partie, galerie
  d'illustrations avec légendes écrites par l'IA (lightbox), carte du monde
  générée par l'IA avec lieux épinglés, export de monde en ZIP, export de carte
  au format SillyTavern (PNG + chara), token d'accès LAN optionnel
  (Réglages → Apparence & sécurité), couleur d'accent et fond personnalisables,
  bannière du dashboard sur la jaquette du monde, raccourcis clavier,
  transitions d'écran (View Transitions API), effets sonores synthétisés
  (whoosh/chime, désactivables), /dice animé, progression live du stream dans
  l'onglet.
- **Images (cohérence visuelle)** : img2img avec le **portrait de la carte en
  image de référence** (fidélité réglable 0,35 → 0,75) quand le personnage a un
  avatar, en plus du seed fixe par carte — la tête reste stable d'une scène à
  l'autre. Scènes décor en format paysage automatique.
- **Contexte** : tours gardés en mémoire configurables par partie, avec un **cap
  global par monde** (Réglages du monde) pour protéger les petits modèles ;
  budget tokens ≈ affiché dans les réglages de partie (source : partie/monde).
- **Sauvegarde** : backup SQLite automatique chaque jour (`data/backups/`, 7
  jours de rotation), backup manuel + état du disque (illustrations/base)
  dans Réglages → Stockage, en plus de l'export/restauration JSON.

## Structure

```
src/server/   API, base de données, routes, import de cartes
src/llm/      providers (LM Studio / OpenRouter) + prompt RP + parsing segments
python/image_server/  sidecar images (diffusers + Koji)
public/       SPA (HTML/CSS/JS)
models/       modèles locaux (Koji)
data/         base SQLite, images générées (créé au runtime)
```