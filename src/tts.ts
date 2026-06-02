// Singleton text-to-speech engine for the golf commentator.
//
// The model (Kokoro) is loaded exactly once and shared between the loading
// screen (which pre-generates every line that can be spoken in a round) and
// the in-game commentator (which just plays the cached audio). Because every
// line is produced through the `line` builders below, the text used at
// preload time matches the text requested at runtime byte-for-byte, so the
// in-game path is a pure cache hit with no generation latency.

const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const KOKORO_VOICE = "am_michael";
const KOKORO_SPEED = 1.15;

// Build the exact commentary strings. Both the preload enumeration and the
// in-game callers must go through these so cache keys line up.
export const line = {
  holeIntro: (number: number, name: string | undefined | null, par: number) =>
    `Hole ${number}. ${name ?? "Next up"}. Par ${par}.`,
  away: (name: string) => `${name} is away.`,
  onTee: (name: string) => `${name} on the tee.`,
  holesOut: (name: string, strokes: number) => `${name} holes out in ${strokes}.`,
  onGreen: (yards: number) => `Safely on the green. ${yards} yards left.`,
  wet: "That one is wet. One stroke penalty.",
  bunker: "It catches the bunker.",
  rough: "That settles down in the rough.",
} as const;

export function normalizeLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

let engine: any = null;
let enginePromise: Promise<any> | null = null;
const audioCache = new Map<string, Blob>();

export function isTtsReady(): boolean {
  return !!engine;
}

type ProgressFn = (fraction: number) => void;

// Load (or return the already-loaded) Kokoro engine. WebGPU is dramatically
// faster than the wasm/CPU backend; fall back to wasm when it isn't available
// so commentary still works everywhere.
export function loadTts(onProgress?: ProgressFn): Promise<any> {
  if (engine) return Promise.resolve(engine);
  if (!enginePromise) {
    enginePromise = (async () => {
      const { KokoroTTS } = await import("kokoro-js");
      const progress_callback = onProgress
        ? (event: any) => {
            const pct = event && typeof event.progress === "number" ? event.progress : 0;
            onProgress(Math.max(0, Math.min(1, pct / 100)));
          }
        : undefined;
      const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
      let loaded: any = null;
      if (hasWebGPU) {
        try {
          loaded = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
            dtype: "fp32",
            device: "webgpu",
            progress_callback,
          });
        } catch (err) {
          console.warn("Kokoro WebGPU unavailable, falling back to wasm", err);
        }
      }
      if (!loaded) {
        loaded = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
          dtype: "q4",
          device: "wasm",
          progress_callback,
        });
      }
      engine = loaded;
      if (onProgress) onProgress(1);
      return loaded;
    })().catch((err) => {
      enginePromise = null;
      throw err;
    });
  }
  return enginePromise;
}

// Generate audio for a line, returning a cached blob instantly if it was
// pre-generated. Loads the engine on demand if it somehow isn't ready yet.
export async function generateLine(text: string): Promise<Blob | null> {
  const key = normalizeLine(text);
  if (!key) return null;
  const cached = audioCache.get(key);
  if (cached) return cached;
  const tts = await loadTts();
  const generated = await tts.generate(key, { voice: KOKORO_VOICE, speed: KOKORO_SPEED });
  const blob: Blob = generated.toBlob();
  audioCache.set(key, blob);
  return blob;
}

export function getCachedLine(text: string): Blob | null {
  return audioCache.get(normalizeLine(text)) ?? null;
}

// Pre-generate every supplied line, reporting progress as a fraction 0..1.
// Duplicates are collapsed so the work (and the progress bar) is accurate.
export async function prewarmLines(
  lines: string[],
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const unique = Array.from(new Set(lines.map(normalizeLine).filter(Boolean)));
  let done = 0;
  for (const text of unique) {
    try {
      await generateLine(text);
    } catch (err) {
      console.warn("TTS prewarm failed for line:", text, err);
    }
    done += 1;
    onProgress?.(unique.length ? done / unique.length : 1);
  }
}
