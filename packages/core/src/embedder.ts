// ─── Embedder Abstraction ─────────────────────────────────────────────────────
// Auto-detects the best available embedding backend in this order:
//   1. OpenAI  (if OPENAI_API_KEY set)
//   2. Ollama  (if running on localhost:11434)
//   3. Xenova  (local model, downloads once ~23MB)
//   4. null    (keyword-only fallback)

export interface Embedder {
  embed(text: string): Promise<number[]>;
  dimensions: number;
  name: string;
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

class OpenAIEmbedder implements Embedder {
  readonly dimensions = 1536;
  readonly name = "openai:text-embedding-3-small";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: text,
        model: "text-embedding-3-small",
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI embeddings failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }
}

// ─── Ollama ───────────────────────────────────────────────────────────────────

const OLLAMA_BASE = process.env.JINAMEM_OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.JINAMEM_OLLAMA_MODEL ?? "nomic-embed-text";

class OllamaEmbedder implements Embedder {
  readonly dimensions = 768;
  readonly name = `ollama:${OLLAMA_MODEL}`;

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text }),
    });

    if (!res.ok) {
      throw new Error(`Ollama embeddings failed: ${res.status}`);
    }

    const data = await res.json() as { embedding: number[] };
    return data.embedding;
  }
}

async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    // Check if the embedding model is available
    const data = await res.json() as { models: Array<{ name: string }> };
    return data.models.some(m => m.name.startsWith(OLLAMA_MODEL));
  } catch {
    return false;
  }
}

// ─── Xenova (local fallback) ──────────────────────────────────────────────────

const XENOVA_MODEL = "Xenova/all-MiniLM-L6-v2";

class XenovaEmbedder implements Embedder {
  readonly dimensions = 384;
  readonly name = `xenova:${XENOVA_MODEL}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipeline: any = null;

  async embed(text: string): Promise<number[]> {
    if (!this.pipeline) {
      // Lazy load — first call triggers model download (~23MB, once only)
      const { pipeline } = await import("@xenova/transformers" as string);
      this.pipeline = await pipeline("feature-extraction", XENOVA_MODEL);
    }

    const output = await this.pipeline(text, { pooling: "mean", normalize: true });
    return Array.from(output.data as Float32Array);
  }
}

// ─── Auto-detection ───────────────────────────────────────────────────────────

let _embedder: Embedder | null | undefined = undefined; // undefined = not resolved yet

export async function getEmbedder(): Promise<Embedder | null> {
  // Return cached result
  if (_embedder !== undefined) return _embedder;

  // 1. OpenAI — if API key is set
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    console.error("[jinamem] using OpenAI embeddings (text-embedding-3-small)");
    _embedder = new OpenAIEmbedder(openaiKey);
    return _embedder;
  }

  // 2. Ollama — if running locally with the embedding model
  if (await isOllamaRunning()) {
    console.error(`[jinamem] using Ollama embeddings (${OLLAMA_MODEL})`);
    _embedder = new OllamaEmbedder();
    return _embedder;
  }

  // 3. Xenova — local model, downloads on first use
  try {
    // Check if @xenova/transformers is available without importing it
    await import("@xenova/transformers" as string);
    console.error("[jinamem] using Xenova local embeddings (all-MiniLM-L6-v2, downloads ~23MB on first use)");
    _embedder = new XenovaEmbedder();
    return _embedder;
  } catch {
    // Package not installed
  }

  // 4. No embedder available — keyword search only
  console.error("[jinamem] no embedding backend found — using keyword search only");
  console.error("[jinamem] for semantic search: set OPENAI_API_KEY, run Ollama, or install @xenova/transformers");
  _embedder = null;
  return null;
}

// ─── Batch embedding ──────────────────────────────────────────────────────────
// Embeds multiple texts efficiently, used for retroactive indexing

export async function embedBatch(
  texts: string[],
  embedder: Embedder,
  batchSize = 20,
): Promise<Array<number[] | null>> {
  const results: Array<number[] | null> = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const embedded = await Promise.all(
      batch.map(t => embedder.embed(t).catch(() => null))
    );
    results.push(...embedded);
  }

  return results;
}

// ─── Serialization ────────────────────────────────────────────────────────────
// SQLite stores vectors as BLOB (Float32Array binary)

export function serializeEmbedding(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer);
}

export function deserializeEmbedding(buf: Buffer): number[] {
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}
