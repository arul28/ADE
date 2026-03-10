# Memory Engine

Technical details specific to the memory engine services being built.

**What belongs here:** Implementation details, API patterns, data formats, algorithm notes.

---

## Embedding Vector Format
- 384 dimensions (all-MiniLM-L6-v2 output)
- Stored as BLOB: `Float32Array` → `Buffer` (384 * 4 = 1,536 bytes per entry)
- Cache keyed by `sha256(content)` of the memory entry text

## Cosine Similarity (Pure TypeScript)
```typescript
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

## BM25 via FTS3/FTS4 + matchinfo()
sql.js includes FTS3 and FTS4, but NOT FTS5. For plain virtual tables, FTS3 works. For **external-content virtual tables** (e.g., `fts4(content, content=unified_memories)`), FTS4 is required — sql.js rejects external-content FTS3 syntax. The `matchinfo()` API is identical in FTS3 and FTS4.

Use FTS3/FTS4 with `matchinfo('pcnalx')` to get term frequency statistics, then compute BM25 in JavaScript:
- p = number of matchable phrases
- c = number of columns
- n = number of rows in FTS table
- a = average number of tokens per column
- l = length of current row's column
- x = 3 values per phrase per column: hits_this_row, hits_all_rows, docs_with_hits

BM25 formula: `sum over terms of: IDF(term) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgDocLen))`
Where k1=1.2, b=0.75, IDF = log((N - df + 0.5) / (df + 0.5) + 1)

Normalize to [0,1]: `score / (score + k)` where k = median score of the result set.

## Hybrid Score Formula
```
hybrid_score = 0.30 * bm25_normalized + 0.70 * cosine_similarity
final_score  = 0.40 * hybrid_score
             + 0.20 * recency_score
             + 0.15 * importance_score
             + 0.15 * confidence_score
             + 0.10 * access_frequency_score
```

## MMR Re-ranking
```
MMR(d) = lambda * sim(query, d) - (1 - lambda) * max(sim(d, d_already_selected))
```
Lambda = 0.7 (favor relevance over diversity). Greedy selection pass over top-N candidates.

## Jaccard Trigram Similarity (for consolidation clustering)
1. Convert text to lowercase trigrams: "hello" → {"hel", "ell", "llo"}
2. Jaccard = |intersection| / |union|
3. Threshold: > 0.7 for cluster membership

## Hard Limits
- Project scope: 2,000 entries
- Agent scope: 500 entries
- Mission scope: 200 entries
- Auto-trigger consolidation at 80% of limit

## Temporal Decay Formula
```
decayed_score = score * Math.pow(0.5, daysSinceAccess / halfLifeDays)
```
Default halfLifeDays = 30. Exempt: Tier 1 (pinned), evergreen categories (preference/convention with importance=high).
