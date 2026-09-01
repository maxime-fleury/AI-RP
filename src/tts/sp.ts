/**
 * SentencePiece tokenizer wrapper (WASM) vendored from bytetrie/pocket-tts-deno
 * (Apache-2.0, based on sentencepiece-wasm). Requires sentencepiece.wasm in
 * the same directory.
 */
import { createSentencePieceModule, type SpModule, type SpProcessor } from "./vendor/sentencepiece.ts";

let modulePromise: Promise<SpModule> | null = null;

async function getModule(): Promise<SpModule> {
  if (!modulePromise) {
    const wasmPath = new URL("./vendor/sentencepiece.wasm", import.meta.url);
    const bytes = await Bun.file(wasmPath).arrayBuffer();
    modulePromise = createSentencePieceModule({ wasmBinary: bytes });
  }
  return modulePromise;
}

export class SentencePieceProcessor {
  #sp!: SpModule;
  #proc!: SpProcessor;

  async loadModel(modelBytes: Uint8Array): Promise<void> {
    const sp = await getModule();
    const tempName = `${crypto.randomUUID()}.model`;
    sp.FS.writeFile(tempName, modelBytes);
    const sv = new sp.StringView(tempName);
    const asv = sv.getView();
    const proc = new sp.SentencePieceProcessor();
    const status = proc.Load(asv);
    status.delete();
    asv.delete();
    sv.delete();
    sp.FS.unlink(tempName);
    this.#sp = sp;
    this.#proc = proc;
  }

  encodeIds(text: string): number[] {
    const sv = new this.#sp.StringView(text);
    const asv = sv.getView();
    const data = this.#proc.EncodeAsIds(asv);
    const arr: number[] = [];
    for (let i = 0; i < data.size(); i++) arr.push(data.get(i));
    data.delete();
    asv.delete();
    sv.delete();
    return arr;
  }

  decodeIds(ids: number[]): string {
    const vec = this.#sp.vecFromJSArray(ids);
    const str = this.#proc.DecodeIds(vec).slice();
    vec.delete();
    return str;
  }
}