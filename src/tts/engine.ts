/**
 * Pocket-TTS inference engine running inside Bun with ONNX Runtime.
 *
 * Port of the official kyutai pipeline + the reference ONNX runtimes
 * (inference-worker.js / pocket-tts-deno / PocketTTS.cpp), driven by the
 * per-bundle `bundle.json` state manifests so FR (24 layers) and EN
 * (6 layers) bundles both work. Voices come from the precomputed
 * embeddings_v3 `.bin`+`.json` files (voice-conditioned flow states).
 */
import * as ort from "onnxruntime-node";
import { SentencePieceProcessor } from "./sp";
import { chunkForTts, normalizeForSpeech, type TtsLang } from "./normalize";
import fs from "node:fs";
import path from "node:path";
import { CPU_COUNT, MODELS_DIR } from "../server/paths";

// ─── Bundle metadata ──────────────────────────────────────────────────────────
export interface ManifestEntry {
  index: number;
  input_name: string;
  output_name: string;
  module: string;
  key: string;
  dtype: string;
  fill: string;
  shape: number[];
}

interface BundleJson {
  bundle_name: string;
  language: string;
  frame_rate: number;
  sample_rate: number;
  samples_per_frame: number;
  max_token_per_chunk: number;
  model_recommended_frames_after_eos: number;
  predefined_voices: string[];
  flow_lm_state_manifest: ManifestEntry[];
  mimi_state_manifest: ManifestEntry[];
}

export interface VoiceInfo {
  name: string;
  languages: "fr" | "en" | ("fr" | "en")[];
  frames: number;
}

type StateMap = Record<string, ort.Tensor>;

interface LoadedBundle {
  lang: TtsLang;
  dir: string;
  meta: BundleJson;
  flowMain: ort.InferenceSession;
  flowFlow: ort.InferenceSession;
  mimiDecoder: ort.InferenceSession;
  textCond: ort.InferenceSession;
  sp: SentencePieceProcessor;
  flowInit: StateMap;
  mimiInit: StateMap;
  voiceCache: Map<string, StateMap>;
  flowInputs: Set<string>;
  flowOutputs: string[];
  textOut: string;
  flowFlowStream?: (names: string[]) => void;
}

const ORT_OPTS: ort.InferenceSession.SessionOptions = {
  executionProviders: ["cpu"],
  graphOptimizationLevel: "all",
  intraOpNumThreads: Math.min(CPU_COUNT, 8),
};

function findName(names: string[], candidates: string[]): string | undefined {
  for (const c of candidates) {
    const hit = names.find((n) => n.toLowerCase().includes(c.toLowerCase()));
    if (hit) return hit;
  }
  return undefined;
}

function mkTensor(dtype: string, data: ArrayBufferView, shape: number[]): ort.Tensor {
  return new ort.Tensor(dtype, data as never, shape);
}

function initFromManifest(manifest: ManifestEntry[]): StateMap {
  const state: StateMap = {};
  for (const e of manifest) {
    const size = e.shape.reduce((a, b) => a * b, 1);
    if (e.dtype === "int64") {
      const data = new BigInt64Array(size);
      if (e.fill === "ones") data.fill(1n);
      state[e.input_name] = new ort.Tensor("int64", data, e.shape);
    } else if (e.dtype === "bool") {
      const data = new Uint8Array(size);
      if (e.fill === "ones") data.fill(1);
      state[e.input_name] = new ort.Tensor("bool", data, e.shape);
    } else {
      const data = new Float32Array(size);
      if (e.fill === "nan") data.fill(NaN);
      state[e.input_name] = new ort.Tensor("float32", data, e.shape);
    }
  }
  return state;
}

function cloneState(s: StateMap): StateMap {
  return { ...s };
}

// ─── Voice files (.bin + .json) ───────────────────────────────────────────────
interface VoiceTensorMeta {
  source_key: string;
  name: string;
  module: string;
  key: string;
  dtype: string;
  offset: number;
  nbytes: number;
  shape: number[];
}

export function listVoiceFiles(): { name: string; exists: boolean }[] {
  const dir = `${MODELS_DIR}/Pocket-tts/embeddings_v3`;
  const entries: { name: string; exists: boolean }[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".json")) entries.push({ name: f.slice(0, -5), exists: true });
    }
  } catch {
    /* models not present */
  }
  return entries;
}

function resolveVoicePaths(bundle: LoadedBundle, voiceName: string): { jsonPath: string; binPath: string } {
  const local = `${bundle.dir}/voices`;
  if (fs.existsSync(path.join(local, `${voiceName}.json`))) {
    return { jsonPath: path.join(local, `${voiceName}.json`), binPath: path.join(local, `${voiceName}.bin`) };
  }
  return {
    jsonPath: path.join(MODELS_DIR, "Pocket-tts", "embeddings_v3", `${voiceName}.json`),
    binPath: path.join(MODELS_DIR, "Pocket-tts", "embeddings_v3", `${voiceName}.bin`),
  };
}

function applyVoiceState(bundle: LoadedBundle, voiceName: string): StateMap {
  const state = cloneState(bundle.flowInit);
  const { jsonPath, binPath } = resolveVoicePaths(bundle, voiceName);
  const meta: { tensors: VoiceTensorMeta[] } = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const bin = new Uint8Array(fs.readFileSync(binPath));
  const byModule = new Map<string, Map<string, ManifestEntry>>();
  for (const e of bundle.meta.flow_lm_state_manifest) {
    if (!byModule.has(e.module)) byModule.set(e.module, new Map());
    byModule.get(e.module)!.set(e.key, e);
  }
  const normDtype = (d: string): string =>
    ({ f4: "float32", f2: "float16", f8: "float64", i8: "int64", i4: "int32" }[d] ?? d);
  for (const t of meta.tensors) {
    const entries = byModule.get(t.module);
    if (!entries) continue;
    // "cache" → the layer's cache state; "offset" → its write-position counter,
    // which this export exposes as the int64 "step" state (current_end stays empty).
    const targetKey = t.key === "offset" ? "step" : t.key;
    const entry = entries.get(targetKey);
    if (!entry) continue;
    const e = entry;
    const tdt = normDtype(t.dtype);
    if (t.key === "offset") {
      // read the scalar value (int64 or float32/16 in the file)
      const view = new DataView(bin.buffer, bin.byteOffset + t.offset, t.nbytes);
      let val: number;
      if (t.nbytes === 8) val = Number(view.getBigInt64(0, true));
      else if (t.nbytes === 4) val = view.getFloat32(0, true);
      else if (t.nbytes === 2) val = view.getFloat16(0, true);
      else val = 0;
      if (e.dtype === "int64") {
        const data = new BigInt64Array(1);
        data[0] = BigInt(Math.round(val));
        state[e.input_name] = new ort.Tensor("int64", data, [1]);
      } else {
        state[e.input_name] = new ort.Tensor("float32", new Float32Array([val]), [1]);
      }
      continue;
    }
    if (tdt === "float16") {
      // half → single precision for the graph
      const src = new Uint16Array(bin.buffer, bin.byteOffset + t.offset, t.nbytes / 2);
      const data = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) data[i] = halfToFloat(src[i]);
      if (t.key === "cache") {
        const full = new Float32Array(e.shape.reduce((a, b) => a * b, 1));
        full.fill(NaN);
        copyPacked(full, data, t.shape, e.shape);
        state[e.input_name] = new ort.Tensor("float32", full, e.shape);
      } else {
        state[e.input_name] = new ort.Tensor("float32", data, t.shape);
      }
      continue;
    }
    const slice = bin.subarray(t.offset, t.offset + t.nbytes);
    if (tdt === "int64") {
      const src = new BigInt64Array(slice.buffer, slice.byteOffset, t.nbytes / 8);
      const copy = new BigInt64Array(src);
      state[e.input_name] = new ort.Tensor("int64", copy, t.shape);
    } else if (tdt === "float32") {
      const src = new Float32Array(slice.buffer, slice.byteOffset, t.nbytes / 4);
      // cache entries are packed at shape [2,1,126,16,64] but the model input
      // expects capacity [2,1,1000,16,64]; NaN-fill spare capacity like torch.
      if (t.key === "cache" && t.shape.every((s, i) => s <= e.shape[i])) {
        const data = new Float32Array(e.shape.reduce((a, b) => a * b, 1));
        data.fill(NaN);
        copyPacked(data, src, t.shape, e.shape);
        state[e.input_name] = new ort.Tensor("float32", data, e.shape);
      } else {
        state[e.input_name] = new ort.Tensor("float32", new Float32Array(src), t.shape);
      }
    }
  }
  return state;
}

/** Copy a packed tensor (src shape) into the prefix of a larger tensor (dst shape). */
function copyPacked(dst: Float32Array, src: Float32Array, srcDims: number[], dstDims: number[]): void {
  const srcInner = srcDims[4] * srcDims[3];
  const dstInner = dstDims[4] * dstDims[3];
  for (let kv = 0; kv < srcDims[0]; kv++) {
    for (let b = 0; b < srcDims[1]; b++) {
      for (let pos = 0; pos < srcDims[2]; pos++) {
        const srcOff = ((kv * srcDims[1] + b) * srcDims[2] + pos) * srcInner;
        const dstOff = ((kv * dstDims[1] + b) * dstDims[2] + pos) * dstInner;
        dst.set(src.subarray(srcOff, srcOff + srcInner), dstOff);
      }
    }
  }
}

function halfToFloat(h: number): number {
  const s = (h >> 15) & 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return m === 0 ? (s ? -0 : 0) : Math.pow(2, -14) * (m / 1024);
  if (e === 31) return m === 0 ? (s ? -Infinity : Infinity) : NaN;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + m / 1024);
}

// ─── Engine ───────────────────────────────────────────────────────────────────
const engines = new Map<TtsLang, LoadedBundle>();

async function loadBundle(lang: TtsLang): Promise<LoadedBundle> {
  const cached = engines.get(lang);
  if (cached) return cached;
  const langId = lang === "fr" ? "french_24l" : "english_2026-04";
  const dir = `${MODELS_DIR}/Pocket-tts/${langId}`;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "bundle.json"), "utf8")) as BundleJson;
  const mk = (name: string) => `${dir}/${name}`;
  const flowMain = await ort.InferenceSession.create(mk("flow_lm_main_int8.onnx"), ORT_OPTS);
  const flowFlow = await ort.InferenceSession.create(mk("flow_lm_flow_int8.onnx"), ORT_OPTS);
  const mimiDecoder = await ort.InferenceSession.create(mk("mimi_decoder_int8.onnx"), ORT_OPTS);
  const textCond = await ort.InferenceSession.create(mk("text_conditioner.onnx"), ORT_OPTS);

  const sp = new SentencePieceProcessor();
  await sp.loadModel(new Uint8Array(fs.readFileSync(mk("tokenizer.model"))));

  const bundle: LoadedBundle = {
    lang,
    dir,
    meta,
    flowMain,
    flowFlow,
    mimiDecoder,
    textCond,
    sp,
    flowInit: initFromManifest(meta.flow_lm_state_manifest),
    mimiInit: initFromManifest(meta.mimi_state_manifest),
    voiceCache: new Map(),
    flowInputs: new Set(flowMain.inputNames),
    flowOutputs: flowMain.outputNames.slice(),
    textOut: textCond.outputNames[0],
  };
  // Preload the bundle's predefined voices.
  for (const v of meta.predefined_voices) {
    try {
      bundle.voiceCache.set(v, applyVoiceState(bundle, v));
    } catch (e) {
      console.warn(`[tts] voice "${v}" not loaded:`, String(e));
    }
  }
  engines.set(lang, bundle);
  console.log(`[tts] ${langId} ready — voices: ${[...bundle.voiceCache.keys()].join(", ")}`);
  return bundle;
}

export function llmVoicesFor(lang: TtsLang): string[] {
  const bundle = engines.get(lang);
  return bundle ? [...bundle.voiceCache.keys()] : [];
}

export async function ensureTtsLoaded(lang: TtsLang = "fr"): Promise<boolean> {
  try {
    await loadBundle(lang);
    return true;
  } catch (e) {
    console.warn("[tts] load failed:", e);
    return false;
  }
}

export interface TtsRequest {
  text: string;
  voice: string;
  lang: TtsLang;
  temperature?: number;
  lsdSteps?: number;
}

function sampleGaussian(std: number, out: Float32Array): void {
  for (let i = 0; i < out.length; i++) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    out[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * std;
  }
}

export interface TtsResult {
  pcm: Float32Array;
  sampleRate: number;
  chunks: string[];
  durationMs: number;
  voice: string;
  lang: TtsLang;
}

export async function synthesize(req: TtsRequest): Promise<TtsResult> {
  const bundle = await loadBundle(req.lang);
  const voiceState = bundle.voiceCache.get(req.voice);
  if (!voiceState) {
    throw new Error(
      `Voix inconnue "${req.voice}" — disponibles: ${[...bundle.voiceCache.keys()].join(", ")}`,
    );
  }
  const temp = req.temperature ?? 0.7;
  const lsd = Math.max(1, Math.min(10, req.lsdSteps ?? 4));
  const maxTokens = bundle.meta.max_token_per_chunk || 50;
  const fid = bundle.flowInputs;
  const seqName = findName(bundle.flowMain.inputNames, ["sequence"]) ?? "sequence";
  const textEmbName = findName(bundle.flowMain.inputNames, ["text_embeddings"]) ?? "text_embeddings";
  const outStates: string[] = bundle.flowOutputs.filter((n) => n.startsWith("out_state_"));
  const condName = findName(bundle.flowOutputs, ["conditioning"]) ?? bundle.flowOutputs[0];
  const eosName = findName(bundle.flowOutputs.filter((n) => !n.startsWith("out_state_")), ["eos"]) ??
    bundle.flowOutputs.find((n) => !n.startsWith("out_state_") && n !== condName) ?? bundle.flowOutputs[0];

  const flowFlowInputs = bundle.flowFlow.inputNames;
  const cName = flowFlowInputs.includes("c") ? "c" : flowFlowInputs[0];
  const sName = flowFlowInputs.includes("s") ? "s" : flowFlowInputs[1] ?? flowFlowInputs[1];
  const tName = flowFlowInputs.includes("t") ? "t" : flowFlowInputs[2];
  const xName = flowFlowInputs.includes("x") ? "x" : flowFlowInputs[flowFlowInputs.length - 1];
  const outFlow = bundle.flowFlow.outputNames[0];

  const mimiLatentName = findName(bundle.mimiDecoder.inputNames, ["latent"]) ?? "latent";
  const mimiStateNames = bundle.mimiDecoder.inputNames.filter((n) => n.startsWith("state_"));
  const mimiAudioOut = bundle.mimiDecoder.outputNames.find((n) => !n.startsWith("out_state_")) ??
    bundle.mimiDecoder.outputNames[0];
  const mimiOutStates = bundle.mimiDecoder.outputNames.filter((n) => n.startsWith("out_state_"));

  const tokenizer = bundle.sp;
  const encode = (s: string) => tokenizer.encodeIds(s);
  const decode = (ids: number[]) => tokenizer.decodeIds(ids);

  const prepared = normalizeForSpeech(req.text, req.lang);
  const chunks = prepared ? chunkForTts(encode, decode, prepared, maxTokens) : [];
  if (chunks.length === 0) throw new Error("Texte vide après normalisation.");

  const emptySeq = new ort.Tensor("float32", new Float32Array(0), [1, 0, 32]);
  const emptyTextEmb = new ort.Tensor("float32", new Float32Array(0), [1, 0, 1024]);
  const ldim = 32;

  const allChunks: Float32Array[] = [];
  const chunkSources: string[] = [];

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunkText = chunks[ci];
    chunkSources.push(chunkText);
    // fresh copies of the pristine states per chunk
    let flowState = cloneState(voiceState);
    let mimiState = cloneState(bundle.mimiInit);

    const tokenIds = new BigInt64Array(encode(chunkText).map((x) => BigInt(x)));
    const textTensor = new ort.Tensor("int64", tokenIds, [1, tokenIds.length]);
    const condRun = await bundle.textCond.run({ token_ids: textTensor });
    let textEmb = condRun[bundle.textOut];
    if (textEmb.dims.length === 2) {
      textEmb = new ort.Tensor("float32", new Float32Array(textEmb.data as Float32Array), [
        1, textEmb.dims[0], textEmb.dims[1],
      ]);
    }
    // text conditioning pass (like "prompting text")
    const condFeed: Record<string, ort.Tensor> = { [seqName]: emptySeq, [textEmbName]: textEmb, ...flowState };
    const condResult = await bundle.flowMain.run(condFeed);
    for (const n of outStates) {
      const idx = n.replace("out_state_", "");
      flowState["state_" + idx] = condResult[n];
    }
    // AR loop
    let currentLatent = new ort.Tensor("float32", new Float32Array(32).fill(NaN), [1, 1, ldim]);
    const chunkLatents: Float32Array[] = [];
    let chunkDecoded = 0;
    let eosStep: number | null = null;
    let firstAudio = true;
    const FRAMES_AFTER_EOS = bundle.meta.model_recommended_frames_after_eos ?? 3;
    const MAX_FRAMES = 500;
    const FIRST_CHUNK_FRAMES = 3, NORMAL_CHUNK_FRAMES = 12;
    const STD = Math.sqrt(temp);
    const dt = 1.0 / lsd;

    for (let step = 0; step < MAX_FRAMES; step++) {
      if (step > 0 && step % 4 === 0) await new Promise((r) => setTimeout(r, 0));
      const feed: Record<string, ort.Tensor> = {
        [seqName]: currentLatent,
        [textEmbName]: emptyTextEmb,
        ...flowState,
      };
      const res = await bundle.flowMain.run(feed);
      const conditioning = res[condName];
      const eosLogit = (res[eosName].data as Float32Array)[0];
      const isEos = eosLogit > -4.0;
      if (isEos && eosStep === null) eosStep = step;
      const shouldStop = eosStep !== null && step >= eosStep + FRAMES_AFTER_EOS;
      // flow matching
      const latent = new Float32Array(ldim);
      sampleGaussian(STD, latent);
      for (let j = 0; j < lsd; j++) {
        const s = j / lsd, t = (j + 1) / lsd;
        const flowRun = await bundle.flowFlow.run({
          [cName]: conditioning,
          [sName]: new ort.Tensor("float32", new Float32Array([s]), [1, 1]),
          [tName]: new ort.Tensor("float32", new Float32Array([t]), [1, 1]),
          [xName]: new ort.Tensor("float32", latent, [1, ldim]),
        });
        const v = flowRun[outFlow].data as Float32Array;
        for (let k = 0; k < ldim; k++) latent[k] += v[k] * dt;
      }
      chunkLatents.push(latent);
      currentLatent = new ort.Tensor("float32", latent, [1, 1, ldim]);
      for (const n of outStates) {
        flowState["state_" + n.replace("out_state_", "")] = res[n];
      }
      // decode batch
      const pending = chunkLatents.length - chunkDecoded;
      let decodeSize = 0;
      if (shouldStop) decodeSize = pending;
      else if (firstAudio && pending >= FIRST_CHUNK_FRAMES) decodeSize = FIRST_CHUNK_FRAMES;
      else if (pending >= NORMAL_CHUNK_FRAMES) decodeSize = NORMAL_CHUNK_FRAMES;
      if (decodeSize > 0) {
        const decoded = await decodeLatents(
          bundle, mimiLatentName, mimiStateNames, mimiAudioOut, mimiOutStates,
          chunkLatents.slice(chunkDecoded, chunkDecoded + decodeSize), ldim, mimiState,
        );
        chunkDecoded += decodeSize;
        firstAudio = false;
        allChunks.push(decoded);
      }
      if (shouldStop) break;
    }
    // flush remaining latents
    if (chunkLatents.length > chunkDecoded) {
      const decoded = await decodeLatents(
        bundle, mimiLatentName, mimiStateNames, mimiAudioOut, mimiOutStates,
        chunkLatents.slice(chunkDecoded), ldim, mimiState,
      );
      allChunks.push(decoded);
    }
    // silence gap between chunks
    if (ci < chunks.length - 1) {
      allChunks.push(new Float32Array(Math.floor(0.25 * bundle.meta.sample_rate)));
    }
  }

  const total = allChunks.reduce((a, c) => a + c.length, 0);
  const pcm = new Float32Array(total);
  let off = 0;
  for (const c of allChunks) { pcm.set(c, off); off += c.length; }
  return {
    pcm,
    sampleRate: bundle.meta.sample_rate,
    chunks: chunkSources,
    durationMs: Math.round((total / bundle.meta.sample_rate) * 1000),
    voice: req.voice,
    lang: req.lang,
  };
}

async function decodeLatents(
  bundle: LoadedBundle,
  mimiLatentName: string,
  mimiStateNames: string[],
  mimiAudioOut: string,
  mimiOutStates: string[],
  latents: Float32Array[],
  ldim: number,
  mimiState: StateMap,
): Promise<Float32Array> {
  const data = new Float32Array(latents.length * ldim);
  for (let i = 0; i < latents.length; i++) data.set(latents[i], i * ldim);
  const feed: Record<string, ort.Tensor> = {
    [mimiLatentName]: new ort.Tensor("float32", data, [1, latents.length, ldim]),
    ...mimiState,
  };
  const res = await bundle.mimiDecoder.run(feed);
  const audio = res[mimiAudioOut].data as Float32Array;
  const out = new Float32Array(audio);
  for (const n of mimiOutStates) {
    mimiState["state_" + n.replace("out_state_", "")] = res[n];
  }
  return out;
}

// ─── WAV output ───────────────────────────────────────────────────────────────
export function wavBytes(pcm: Float32Array, sampleRate: number): Uint8Array {
  const pcm16 = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    pcm16[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  const buf = new ArrayBuffer(44 + pcm16.length * 2);
  const view = new DataView(buf);
  const enc = new TextEncoder();
  const w4 = (o: number, s: string) => enc.encode(s).forEach((b, i) => view.setUint8(o + i, b));
  w4(0, "RIFF");
  view.setUint32(4, 36 + pcm16.length * 2, true);
  w4(8, "WAVE");
  w4(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w4(36, "data");
  view.setUint32(40, pcm16.length * 2, true);
  new Uint8Array(buf, 44).set(new Uint8Array(pcm16.buffer));
  return new Uint8Array(buf);
}