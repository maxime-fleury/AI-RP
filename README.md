# AI-RP — Roleplay & Mondes

Interface web de roleplay avec IA : crée des mondes (isekai…), importe des cartes
de personnages SillyTavern, définis des scénarios et joue avec un narrateur + des
personnages — le tout avec **voix différentes par rôle** (TTS local) et
**illustrations générées** (Koji / SDXL).

## Démarrage

```bash
# 1. Lancer l'API compatible OpenAI (LM Studio sur http://172.17.240.1:3007/v1, par ex.)
# 2. Lancer le serveur de l'app
PORT=3210 bun src/index.ts
# → http://localhost:3210
```

- Le port est choisi par `PORT` (sinon 3000→3600 automatiquement).
- L'URL de LM Studio et le modèle se règlent dans **Réglages** (⚙️) de l'app.
- Le TTS (Pocket-TTS, 8 voix FR + EN) se précharge au démarrage ; les voix se
  règlent par rôle dans les réglages, avec override par carte.
- Le **Breeze-TTS-2** (3B, haute qualité, GPU) est un second moteur optionnel :
  choisis-le dans **Réglages → Voix** (moteur de voix). Voir « Breeze-TTS-2 »
  ci-dessous.
- Le serveur d'images (Koji) se lance automatiquement à la première demande.

## Breeze-TTS-2 (moteur de voix optionnel)

Breeze est un moteur de synthèse de haute qualité (3B, PyTorch + CUDA) qui fait
tourner un sidecar Python sur la machine. Contrairement à Pocket-TTS (voix
embarquées), chaque **voix Breeze est une consigne de voix** : tu décris le
timbre, le débit et le tempérament en une phrase, et le modèle l'incarne. Tu
peux **créer, modifier et supprimer** ces presets depuis **Réglages → Voix**
(éditeur de voix Breeze).

### Installation (une seule fois)

```bash
# 1. Environnement Python (torch CUDA + deps) — fait dans python/breeze_server/.venv
cd python/breeze_server
# (venv déjà créé ; sinon :)
# python -m venv .venv && .venv/Scripts/activate
# pip install torch==2.10.0+cu130 torchaudio==2.10.0+cu130 --index-url https://download.pytorch.org/whl/cu130
# puis : pip install -r requirements.txt

# 2. Télécharger le modèle (~7,2 Go) dans models/Breeze-TTS-2
.venv/Scripts/python.exe download_model.py
```

Le sidecar est lancé automatiquement par l'app au premier besoin (chargement du
modèle ~1–2 min) sur le port 8771. Sans GPU il ne fonctionne pas : Breeze
requiert CUDA (flash-attn absent → bascule automatique en attention eager).

### Usage

- Dans **Réglages → Voix**, choisis « Breeze-TTS-2 » comme moteur, puis une voix
  par rôle (narrateur / personnages). Les presets Breeze sont édités dans le
  panneau « Voix Breeze (éditeur) ».
- Modifier la description d'une voix en change le timbre et **invalide le cache**
  audio de cette voix.

| Commande | Rôle |
| --- | --- |
| `python/breeze_server/.venv/Scripts/python.exe python/breeze_server/server.py --port 8771` | Sidecar Breeze (manuel) |
| `python/breeze_server/download_model.py` | Télécharge le modèle (~7 Go) |

## Scripts utiles

| Commande | Rôle |
| --- | --- |
| `bun src/index.ts` | Serveur de l'app (API + SPA) |
| `bun test` | Tests unitaires (routage, prompt, import, TTS) |
| `bun run check` | Build + tests (CI locale) |
| `bun scripts/test-api.ts` | Test d'intégration API de bout en bout |
| `bun scripts/test-tts.ts fr jean "…"` | Synthèse vocale en CLI |
| `python python/image_server/server.py --port 8770` | Sidecar images Koji |

## Sauvegarde

- **Réglages → Sauvegarde** : « ⬇️ Exporter tout » télécharge un JSON complet
  (mondes, scénarios, cartes, personas, conversations) ; « ⬆️ Restaurer »
  recrée tout depuis un fichier.
- Le dossier `data/` contient la base SQLite et tous les fichiers générés
  (audio + images) : copie-le régulièrement pour tout conserver, ou ajoute
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
- **TTS** : Pocket-TTS (ONNX) dans Bun — voix par rôle : narrateur, joueur, chaque
  personnage (réglages globaux + override par carte). Audio pré-généré en
  arrière-plan (messages récents sans voix synthétisés à l'ouverture) ; les
  segments courts sont fusionnés et le nombre de segments par réponse est
  configurable (le reste se génère à la demande).
- **Images** : Koji v2.1 (SD 1.5) via sidecar Python (diffusers + torch CUDA),
  illustrations de scène en prompt style tags danbooru (FR→EN) + négatif complet ;
  les scènes de décor sont détectées et générées en format paysage (seed affiché,
  bouton « Variante »). Pré-chargement du modèle au démarrage en option.
- **Front** : SPA vanilla, deux thèmes (glassmorphism néon / anime vibrant),
  import de cartes PNG+JSON (spec SillyTavern V1/V2).
- **Quality of life** : bouton ⏹ Stop pendant la génération (le partiel est
  conservé), autocomplétion des slash commands (menu type Discord),
  mini-lecteur de segments (clic sur un segment → 0,75×/1×/1,25×), réactions
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
  l'onglet, notification quand la voix est prête.
- **Images (cohérence visuelle)** : img2img avec le **portrait de la carte en
  image de référence** (fidélité réglable 0,35 → 0,75) quand le personnage a un
  avatar, en plus du seed fixe par carte — la tête reste stable d'une scène à
  l'autre. Scènes décor en format paysage automatique.
- **Contexte** : tours gardés en mémoire configurables par partie, avec un **cap
  global par monde** (Réglages du monde) pour protéger les petits modèles ;
  budget tokens ≈ affiché dans les réglages de partie (source : partie/monde).
- **Sauvegarde** : backup SQLite automatique chaque jour (`data/backups/`, 7
  jours de rotation), backup manuel + état du disque (audio/illustrations/base)
  dans Réglages → Stockage, en plus de l'export/restauration JSON.

## Structure

```
src/server/   API, base de données, routes, import de cartes
src/llm/      providers (LM Studio / OpenRouter) + prompt RP + parsing segments
src/tts/      moteur Pocket-TTS (tokenizer WASM, inférence ONNX), service + voix,
               client Breeze (sidecar) + presets de voix
python/image_server/  sidecar images (diffusers + Koji)
python/breeze_server/ sidecar Breeze-TTS-2 (PyTorch + CUDA) + clone du repo officiel
public/       SPA (HTML/CSS/JS)
models/       modèles locaux (Koji, Pocket-TTS, Breeze-TTS-2)
data/samples/ échantillons de voix TTS pré-générés (aperçu dans les réglages)
data/         base SQLite, audio et images générées (créé au runtime)
```
