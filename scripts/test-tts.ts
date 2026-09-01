/**
 * CLI smoke test for the TTS engine.
 *   bun scripts/test-tts.ts [fr|en] [voice] ["text"]
 */
import { synthesize, wavBytes, ensureTtsLoaded, listVoiceFiles } from "../src/tts/engine";
import { AUDIO_DIR } from "../src/server/paths";

const lang = (process.argv[2] as "fr" | "en") || "fr";
const voice = process.argv[3] || "jean";
const text = process.argv[4] || "Bonjour. Je suis le narrateur de cette aventure épique, et je t'accueille dans un monde nouveau.";

console.log(`[test] lang=${lang} voice=${voice}`);
console.log("[test] voices on disk:", listVoiceFiles().map((v) => v.name).join(", "));
const ok = await ensureTtsLoaded(lang);
if (!ok) {
  console.error("[test] TTS failed to load — abort.");
  process.exit(1);
}
const t0 = performance.now();
const res = await synthesize({ text, voice, lang, lsdSteps: 4 });
const t1 = performance.now();
console.log(`[test] synthesized ${res.durationMs} ms of audio in ${Math.round(t1 - t0)} ms (chunks: ${res.chunks.length})`);
Bun.write(`${AUDIO_DIR}/test-${lang}-${voice}.wav`, wavBytes(res.pcm, res.sampleRate));
console.log(`[test] wrote ${AUDIO_DIR}/test-${lang}-${voice}.wav`);

// quick sanity metrics on the audio
let rms = 0, peak = 0;
for (const s of res.pcm) { rms += s * s; peak = Math.max(peak, Math.abs(s)); }
rms = Math.sqrt(rms / res.pcm.length);
console.log(`[test] rms=${rms.toFixed(4)} peak=${peak.toFixed(4)} samples=${res.pcm.length}`);
if (peak < 0.001) { console.error("[test] !! audio is silent — check the pipeline"); process.exit(2); }
console.log("[test] OK");