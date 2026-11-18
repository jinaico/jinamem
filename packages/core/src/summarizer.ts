/**
 * summarizer.ts — session decision extractor
 *
 * On session end, calls a model to distill what happened into
 * durable decision-log entries. Auto-detects available model:
 *
 *   JINAMEM_ANTHROPIC_KEY → Claude Haiku (cheapest, best quality)
 *   JINAMEM_OPENAI_KEY    → GPT-4o-mini
 *   OPENAI_API_KEY        → GPT-4o-mini (reuse dev's existing key)
 *   Ollama running        → llama3.2 or first available model
 *   (none)                → skip summarization silently
 *
 * Cost: ~$0.001 per session with Haiku/4o-mini.
 * Output: 3–6 bullet points written as pinned facts.
 */

export interface SummaryClient {
  name: string;
  summarize(prompt: string): Promise<string>;
}

// ─── Anthropic (Claude Haiku) ─────────────────────────────────────────────────

class AnthropicClient implements SummaryClient {
  name = "claude-haiku";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async summarize(prompt: string): Promise<string> {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!resp.ok) throw new Error(`Anthropic API error: ${resp.status}`);
    const data = await resp.json() as {
      content: Array<{ type: string; text: string }>;
    };
    return data.content.find(b => b.type === "text")?.text ?? "";
  }
}

// ─── OpenAI (GPT-4o-mini) ────────────────────────────────────────────────────

class OpenAIClient implements SummaryClient {
  name = "gpt-4o-mini";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async summarize(prompt: string): Promise<string> {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!resp.ok) throw new Error(`OpenAI API error: ${resp.status}`);
    const data = await resp.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message.content ?? "";
  }
}

// ─── Ollama (local) ───────────────────────────────────────────────────────────

class OllamaClient implements SummaryClient {
  name: string;
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.name = `ollama/${model}`;
  }

  async summarize(prompt: string): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: { num_predict: 512 },
      }),
    });

    if (!resp.ok) throw new Error(`Ollama error: ${resp.status}`);
    const data = await resp.json() as { response: string };
    return data.response ?? "";
  }
}

// ─── Auto-detection ───────────────────────────────────────────────────────────

let cachedClient: SummaryClient | null | undefined = undefined;

export async function getSummaryClient(): Promise<SummaryClient | null> {
  if (cachedClient !== undefined) return cachedClient;

  // 1. Anthropic key (jinamem-specific or shared)
  const anthropicKey = process.env.JINAMEM_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    cachedClient = new AnthropicClient(anthropicKey);
    return cachedClient;
  }

  // 2. OpenAI key (jinamem-specific or shared)
  const openaiKey = process.env.JINAMEM_OPENAI_KEY ?? process.env.OPENAI_API_KEY;
  if (openaiKey) {
    cachedClient = new OpenAIClient(openaiKey);
    return cachedClient;
  }

  // 3. Ollama — ping and find a usable model
  const ollamaBase = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  try {
    const signal = AbortSignal.timeout(1500);
    const resp = await fetch(`${ollamaBase}/api/tags`, { signal });
    if (resp.ok) {
      const data = await resp.json() as { models: Array<{ name: string }> };
      const models = data.models.map(m => m.name);

      // Prefer small fast models for summarization
      const preferred = ["llama3.2", "llama3.1", "llama3", "mistral", "phi3"];
      const model = preferred.find(p => models.some(m => m.startsWith(p)))
        ?? models[0];

      if (model) {
        cachedClient = new OllamaClient(ollamaBase, model);
        return cachedClient;
      }
    }
  } catch {
    // Ollama not running — skip
  }

  cachedClient = null;
  return null;
}

// ─── Summarization prompt ─────────────────────────────────────────────────────

export function buildSummaryPrompt(
  project: string,
  attempts: Array<{ action: string; result?: string; success: boolean }>,
  existingFacts: string[],
): string {
  const attemptLines = attempts
    .slice(-40) // last 40 attempts to stay within context
    .map(a => `- [${a.success ? "ok" : "fail"}] ${a.action}${a.result ? `: ${a.result.slice(0, 150)}` : ""}`)
    .join("\n");

  const factsContext = existingFacts.length > 0
    ? `\nAlready known about this project:\n${existingFacts.map(f => `- ${f}`).join("\n")}\n`
    : "";

  return `You are summarizing a coding session for project "${project}".
Extract only NEW decisions, discoveries, or architectural choices made this session.
Skip routine actions (file edits, running tests). Focus on WHY things were done.${factsContext}

Session activity:
${attemptLines}

Output 2–5 bullet points in this exact format (one per line, no intro text):
• <decision or discovery> — <brief reason>

If nothing worth remembering happened, output exactly: NOTHING

Examples of good output:
• switched from JWT to session tokens — JWT expiry was causing mobile logout issues
• postgres connection pool set to 5 — higher caused timeouts on small VPS
• decided against websockets for now — SSE is simpler and covers our use case`;
}

// ─── Parse model output into facts ───────────────────────────────────────────

export function parseSummaryOutput(output: string): string[] {
  if (!output || output.trim().toUpperCase() === "NOTHING") return [];

  return output
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("•") || line.startsWith("-") || line.startsWith("*"))
    .map(line => line.replace(/^[•\-*]\s*/, "").trim())
    .filter(line => line.length > 10 && line.length < 300);
}
