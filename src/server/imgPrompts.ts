/**
 * Illustration prompt building (extracted from routes/core.ts): danbooru- *  style negative prompt, FR→EN tag map and the landscape/character/scene
 *  detectors used to assemble img2img prompts for the Koji/SDXL pipeline.
 *  Pure functions — no DB, no HTTP.
 */
import { parseSegments } from "../llm/prompt";



// ─── router ───────────────────────────────────────────────────────────────────

// standard danbooru-style negative prompt for anime SDXL checkpoints
export const NEGATIVE_PROMPT =
  "worst quality, low quality, lowres, bad anatomy, bad hands, missing fingers, extra digits, " +
  "fewer digits, extra limbs, mutated hands and fingers, deformed, disfigured, blurry, out of focus, " +
  "ugly, duplicate, monochrome, text, watermark, signature, logo, jpeg artifacts, frame, border";


// common FR-EN keyword map: tag-trained anime models understand English tags
export const IMG_TAGS_FR2EN: Record<string, string> = {
  temple: "grand temple", "château": "castle", "chateau": "castle", "forêt": "dense forest", "foret": "dense forest",
  "montagne": "mountain range", "grottes": "cavern", "grotte": "cavern", "rivière": "river", "riviere": "river",
  "lac": "lake", "océan": "ocean", "ocean": "ocean", "neige": "snow", "pluie": "rain, wet", "orage": "storm clouds",
  "rune": "glowing runes, arcane symbols", "runes": "glowing runes, arcane symbols", "magie": "magic circles, glowing magic",
  "lame": "glass sword, radiant blade", "épée": "ornate sword", "epee": "ornate sword", "bouclier": "shield",
  "flamme": "open flame, fire", "feu": "bonfire, embers", "ombre": "dark shadows, silhouettes", "ténèbres": "darkness, gloom", "tenebres": "darkness, gloom",
  "cendres": "floating ashes, apocalyptic", "mort": "skulls, dark fantasy", "dieux": "ancient statues", "autel": "stone altar",
  "statue": "stone statue", "colonnes": "ancient pillars", "portail": "portal, glowing gate", "escalier": "stone staircase",
  "toits": "medieval roofs", "salle": "stone hall", "trône": "throne", "trone": "throne", "crystal": "crystaline details", "cristal": "crystaline details", "gemme": "glowing gem",
  "sang": "dripping blood, dark", "squelette": "skeleton", "serpent": "serpent", "dragon": "dragon", "loup": "wolf", "corbeau": "raven", "chene": "ancient oak", "arbre": "ancient tree",
  "bougie": "candlelight", "fumée": "smoke, mist", "fumee": "smoke, mist", "brume": "mist, fog", "lune": "full moon", "étoiles": "starry night sky", "etoiles": "starry night sky", "ciel": "dramatic sky",
  "flèches": "arrows", "fleches": "arrows", "arc": "longbow", "armure": "armor, knight", "cape": "cape, cloak", "masque": "mask, masked", "ailes": "large wings", "alle": "large wings",
  "combat": "battle scene", "bataille": "epic battle", "guerre": "war-torn landscape", "village": "small village", "ville": "fantasy city", "tour": "tower, spire", "pont": "ancient bridge",
  "fleur": "flowers, nature", "fleurs": "flowers, nature", "herbe": "grass, nature", "falaise": "cliffside", "désert": "desert dunes", "desert": "desert dunes", "volcan": "volcano",
};


export const LANDSCAPE_WORDS = new Set([
  "temple", "château", "chateau", "forêt", "foret", "montagne", "grottes", "grotte", "rivière", "riviere",
  "lac", "océan", "ocean", "mer", "neige", "pluie", "orage", "ciel", "étoiles", "etoiles", "lune", "désert", "desert",
  "volcan", "village", "ville", "pont", "tour", "falaise", "plaine", "vallée", "vallee", "palais", "ruines", "prairie",
  "chene", "arbre", "fleur", "fleurs", "herbe", "lande", "port", "fjord", "donjon", "cols", "salle", "autel", "statue",
  "trône", "trone", "escalier", "toits", "bougie", "brume", "fumée", "fumee", "cendres", "portail", "colonnes", "monument",
]);


/** Guess the kind of image a message calls for: pure scenery → landscape. */
export function detectSceneKind(content: string): "landscape" | "portrait" {
  // drop dialogue lines, keep narration words (asterisks become spaces so a
  // fully italic message is not stripped bare)
  const withoutDialogue = content.replace(/"[^"]*"/g, " ").replace(/\*/g, " ");
  const words = withoutDialogue
    .toLowerCase()
    .split(/[^\p{L}'-]+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length > 2); // keep 3-letter words like mer/lac
  const hits = words.filter((w) => LANDSCAPE_WORDS.has(w)).length;
  const wc = words.length;
  return hits >= 2 && wc >= 5 ? "landscape" : "portrait";
}


/** Deterministic seed per card — the same character always gets the same seed. */
export function charSeed(cardId: number): number {
  return ((cardId * 2654435761) >>> 0) % 2_147_483_647;
}


/**
 * If the message is (mostly) a character's line, return that card so the
 * illustration keeps their look (prompt identity + fixed seed).
 */
export function characterForMessage(cast: { id: number; name: string; description?: string }[], content: string): { id: number; name: string; description: string } | null {
  if (!cast.length) return null;
  // first dialogue speaker of the message wins (the scene is about them)
  for (const seg of parseSegments(content)) {
    if (seg.type === "dialogue" && seg.speaker) {
      const card = cast.find((c) => c.name.toLowerCase() === seg.speaker.toLowerCase());
      if (card) return { id: card.id, name: card.name, description: card.description ?? "" };
    }
  }
  // narration mentioning a cast member by name → that character
  const lower = content.toLowerCase();
  const card = cast.find((c) => c.name.length > 2 && lower.includes(c.name.toLowerCase()));
  return card ? { id: card.id, name: card.name, description: card.description ?? "" } : null;
}


/** Card description → danbooru-style tags (shared pipeline with the scene prompt). */
export function descriptionToTags(desc: string): string[] {
  const raw = desc.replace(/[*"«»]/g, " ").replace(/\s+/g, " ").trim();
  const words = raw
    .toLowerCase()
    .split(/[^\p{L}'-]+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    const t = IMG_TAGS_FR2EN[w] ?? w;
    if (seen.has(t)) continue;
    seen.add(t);
    tags.push(t);
  }
  return tags;
}


export const STOP_WORDS = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "dans", "sur", "sous", "avec", "pour", "plus", "pas",
  "très", "tres", "mais", "comme", "lui", "elle", "il", "ils", "tu", "vous", "je", "me", "moi", "mon", "ma", "mes",
  "ton", "ta", "tes", "sa", "son", "ses", "ce", "cet", "cette", "ces", "au", "aux", "en", "par", "se", "si", "ne",
  "y", "vers", "contre", "entre", "tout", "tous", "alors", "quand", "où", "ou", "comment", "pourquoi", "à", "a", "était",
  "etait", "être", "fait", "faire", "voit", "vois", "dit", "dis", "demande", "répond", "repond", "veux", "veut", "peux",
  "peut", "semble", "déjà", "deja", "encore", "aussi", "bien", "même", "meme", "autre", "rien", "quelque", "petite", "petit",
  "grand", "grande", "toujours", "jamais", "seul", "seule", "place", "peu", "long", "voix", "regarde", "sait", "savez", "sais",
  "face", "côté", "cote", "doit", "faites", "êtes", "etes",
]);


export function buildIllustrationPrompt(world: string, desc: string, tone: string, scene: string, kind: "auto" | "landscape" | "portrait" = "auto", character?: { id: number; name: string; description?: string } | null): string {
  // strip roleplay markup, keep a clean lowercase word list
  const raw = scene.replace(/[*"«»]/g, " ").replace(/\s+/g, " ").trim();
  const words = raw
    .toLowerCase()
    .split(/[^\p{L}'-]+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  // translate known words, keep unique order
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    const t = IMG_TAGS_FR2EN[w] ?? w;
    if (seen.has(t)) continue;
    seen.add(t);
    tags.push(t);
  }
  // keep the prompt in tags: translate the tone, drop French prose (tag-trained
  // anime models respond poorly to natural-language sentences)
  const TONE_EN: Record<string, string> = {
    "épique": "epic", "epique": "epic", "sombre": "dark, grim", "léger": "lighthearted",
    "leger": "lighthearted", "mystérieux": "mysterious", "mysterieux": "mysterious",
    "comique": "comedic", "heroïque": "heroic", "heroique": "heroic", "neutre": "",
  };
  const worldPart = [world || "fantasy", TONE_EN[String(tone || "").toLowerCase().trim()] || ""].filter(Boolean).join(", ");
  // character identity: description-derived tags + name + stable face framing
  let charPart: string[] = [];
  if (character) {
    charPart = [
      "character focus, one character",
      ...descriptionToTags(character.description),
      character.name.replace(/\s+/g, "_"),
      "solo, upper body, detailed face, face focus, looking at viewer",
    ].filter(Boolean);
  }
  // environment-only scenes: push the scenery, keep the frame empty of people
  const sceneOverride =
    kind === "landscape"
      ? ["scenery, breathtaking landscape, wide angle shot, vast vista, clear composition", "no people, no characters, empty scene, background focus"]
      : ["cinematic lighting, dramatic composition, detailed background, depth of field, sharp focus"];
  // danbooru-style: quality tags first, then environment, scene keywords, style
  return [
    "masterpiece, best quality, anime illustration, highly detailed, vibrant colors",
    worldPart,
    ...charPart,
    tags.slice(0, 12).join(", "),
    ...sceneOverride,
  ].filter(Boolean).join(", ");
}
