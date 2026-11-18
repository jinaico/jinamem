// ─── Similarity & Ranking ────────────────────────────────────────────────────

// Cosine similarity between two vectors (0 = unrelated, 1 = identical)
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Reciprocal Rank Fusion ───────────────────────────────────────────────────
// Merges two ranked result lists into one. Better than averaging scores.
// k=60 is the standard constant from the original RRF paper.

export interface RankedResult {
  id: string;
  content: string;
  score: number;
  source: "semantic" | "keyword" | "hybrid";
}

export function reciprocalRankFusion(
  semanticResults: Array<{ id: string; content: string; score: number }>,
  keywordResults: Array<{ id: string; content: string; score: number }>,
  k = 60,
): RankedResult[] {
  const scores = new Map<string, { content: string; rrfScore: number; sources: Set<string> }>();

  // Score from semantic ranking
  semanticResults.forEach((r, rank) => {
    const existing = scores.get(r.id) ?? { content: r.content, rrfScore: 0, sources: new Set() };
    existing.rrfScore += 1 / (k + rank + 1);
    existing.sources.add("semantic");
    scores.set(r.id, existing);
  });

  // Score from keyword ranking
  keywordResults.forEach((r, rank) => {
    const existing = scores.get(r.id) ?? { content: r.content, rrfScore: 0, sources: new Set() };
    existing.rrfScore += 1 / (k + rank + 1);
    existing.sources.add("keyword");
    scores.set(r.id, existing);
  });

  return Array.from(scores.entries())
    .map(([id, { content, rrfScore, sources }]) => ({
      id,
      content,
      score: rrfScore,
      source: (sources.has("semantic") && sources.has("keyword")
        ? "hybrid"
        : sources.has("semantic")
          ? "semantic"
          : "keyword") as RankedResult["source"],
    }))
    .sort((a, b) => b.score - a.score);
}

// Minimum cosine similarity to include a result (filters out irrelevant matches)
export const SIMILARITY_THRESHOLD = 0.35;
