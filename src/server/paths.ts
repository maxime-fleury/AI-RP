import { cpus } from "node:os";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dir, "../..");
export const MODELS_DIR = path.join(ROOT, "models");
export const DATA_DIR = path.join(ROOT, "data");
export const AUDIO_DIR = path.join(DATA_DIR, "audio");
export const SAMPLES_DIR = path.join(DATA_DIR, "samples");
export const IMAGES_DIR = path.join(DATA_DIR, "images");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const DB_PATH = path.join(DATA_DIR, "app.db");
export const PUBLIC_DIR = path.join(ROOT, "public");
export const PYTHON_DIR = path.join(ROOT, "python", "image_server");
export const CPU_COUNT = cpus().length;