# W7a: Embeddings Pipeline
> Source: [sqlite-vec](https://github.com/asg017/sqlite-vec) — native SQLite extension for vector search with `vec0` virtual tables. [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) — 384-dim sentence embedding model (~25MB GGUF). [BM25/FTS5](https://www.sqlite.org/fts5.html) — full-text search for keyword relevance scoring. [MMR — Maximal Marginal Relevance](https://www.cs.cmu.edu/~jgc/publication/The_Use_MMR_Diversity_Based_LTMIR_1998.pdf) — re-ranking to reduce redundancy.

##### Required Reading for Implementation

| Reference | What to Read | What ADE Adopts |
|-----------|-------------|-----------------|
| [sqlite-vec README + API](https://alexgarcia.xyz/sqlite-vec/) | Full docs — `vec0` virtual table, `vec_distance_cosine()`, BLOB format, brute-force KNN, Node.js binding | Native SQLite extension loaded in Electron main process, cosine distance for similarity scoring, brute-force search (no index needed at < 100K vectors) |
| [sqlite-vec Node.js Bindings](https://github.com/asg017/sqlite-vec/tree/main/bindings/node) | Setup, `loadExtension()` call, `better-sqlite3` integration | Extension loading pattern for Electron's `better-sqlite3` driver |
| [all-MiniLM-L6-v2 Model Card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) | Model card — 384 dimensions, performance benchmarks, GGUF availability, inference characteristics | Local embedding model, 384-dim output, ~25MB weight file, sub-100ms per entry on modern hardware |
| [SQLite FTS5](https://www.sqlite.org/fts5.html) | `CREATE VIRTUAL TABLE ... USING fts5()`, `bm25()` function, content-sync tables | BM25 keyword scoring for hybrid retrieval, external-content FTS5 table mirroring `unified_memories` |
| [MMR — Carbonell & Goldstein 1998](https://www.cs.cmu.edu/~jgc/publication/The_Use_MMR_Diversity_Based_LTMIR_1998.pdf) | MMR formula: `lambda * sim(q, d) - (1-lambda) * max(sim(d, d_selected))` | Re-ranking pass to reduce redundancy in search results. Lambda = 0.7 (favor relevance over diversity). |
| [OpenClaw — `memory/embedding.py`](https://github.com/nichochar/openclaw/tree/main/src/openclaw/memory) | Embedding cache pattern, async embedding queue, graceful fallback | Content-hash embedding cache, background processing queue, lexical fallback when embeddings unavailable |

W7a adds vector embeddings to the unified memory system shipped in W6. The current retrieval path is lexical/composite scoring only — keywords plus recency/importance/confidence/access signals. Embeddings upgrade general memory retrieval to hybrid semantic+lexical and are a prerequisite for W7c (Skills + Learning) which needs cosine similarity for episode clustering and procedure dedup.

##### sqlite-vec Integration

Load [sqlite-vec](https://github.com/asg017/sqlite-vec) as a native SQLite extension in the Electron main process. sqlite-vec provides `vec0` virtual tables for brute-force KNN search using standard SQL — no external vector database, no network calls, no additional process.

- **Extension loading**: Call `db.loadExtension()` on the existing `better-sqlite3` instance during `kvDb.ts` initialization. The extension binary ships as a platform-specific native module (darwin-arm64, darwin-x64, linux-x64, win32-x64) bundled via Electron's `extraResources`.
- **Embeddings virtual table**: Create a `vec0` virtual table linked to `unified_memory_embeddings`:
  ```sql
  create virtual table if not exists vec_unified_memory_embeddings using vec0(
    memory_id text primary key,
    embedding float[384]
  );
  ```
- **Vector dimensions**: 384 (all-MiniLM-L6-v2 output size). Stored as BLOB in the `vec0` table and as `embedding_blob` in the existing `unified_memory_embeddings` relational table.
- **Search**: `vec_distance_cosine()` for similarity scoring. Brute-force KNN scan (no HNSW or IVF index needed — at < 100K vectors the brute-force scan is < 10ms).
- **Scope filtering**: KNN search returns top-N across all entries, then post-filter by `project_id`, `scope`, and `scope_owner_id` to respect memory isolation. Alternative: maintain per-scope partition tables if post-filter cardinality becomes a bottleneck (unlikely before 100K entries).

##### Local Embedding Model

Local inference using [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) in GGUF format. No API calls, no network dependency, fully offline.

- **Weight file**: ~25MB GGUF. Ship as an Electron `extraResource` (bundled with the app) or download on first use with a progress indicator. Store at `<appData>/models/all-MiniLM-L6-v2.gguf`.
- **Inference runtime**: Use a lightweight ONNX/GGUF inference library compatible with Node.js (e.g., `@xenova/transformers` or a native binding). Run inference on the main process thread pool — embedding is CPU-bound but fast (~20-80ms per entry).
- **Embedding cache**: Keyed by `sha256(content)`. Stored in `embeddings.db` (separate SQLite file, gitignored, listed in `.ade/` directory structure under W10). Cache is regenerable — if `embeddings.db` is deleted, the backfill job recreates all embeddings from `unified_memories` content.
  ```typescript
  interface EmbeddingCacheEntry {
    contentHash: string;       // sha256(content)
    embeddingBlob: Buffer;     // 384 * 4 bytes = 1,536 bytes per entry
    modelVersion: string;      // "all-MiniLM-L6-v2-gguf-v1"
    createdAt: string;
  }
  ```
- **Cache hit path**: On `memoryAdd`, compute `sha256(content)` → check cache → if hit, use cached vector → skip inference. Avoids re-embedding on content dedup/merge cycles.

##### Background Embedding Job

Embeddings are generated asynchronously — they never block memory writes or reads.

- **On `memoryAdd`**: Insert the memory entry immediately (W6 write gate runs synchronously). Queue the entry ID for embedding. Return to caller without waiting for the embedding.
- **Background worker**: `embeddingWorkerService.ts` processes the embedding queue in batches of 10-50 entries. Each batch: load content → run inference → write vectors to `vec_unified_memory_embeddings` and `unified_memory_embeddings` tables → update the `unified_memories.embedding` field pointer.
- **Backfill on startup**: Query `unified_memories` for entries with no corresponding row in `unified_memory_embeddings`. Queue them for embedding. This handles entries written before the embedding pipeline was enabled, entries from legacy backfill, and recovery after `embeddings.db` deletion.
- **Performance target**: < 100ms per entry on M1/M2 hardware. A backfill of 1,000 entries completes in < 2 minutes. The queue processes in the background without blocking the UI or agent operations.
- **Graceful degradation**: If the embedding model fails to load (missing weight file, incompatible platform, corrupted download), log a warning and disable the embedding pipeline. All memory operations continue via lexical search. The health dashboard shows "Embeddings: unavailable — reason" instead of a progress bar.
- **Rate limiting**: The background worker yields to the event loop between batches (100ms pause) to avoid monopolizing CPU during active user sessions. Batch size adjusts down when the app is in the foreground with active agent runs.

##### Hybrid Retrieval Upgrade

Replace the current 100% lexical composite scoring with a hybrid path that combines keyword relevance and semantic similarity.

- **FTS5 virtual table**: Create an external-content FTS5 table mirroring `unified_memories.content`:
  ```sql
  create virtual table if not exists unified_memories_fts using fts5(
    content,
    content=unified_memories,
    content_rowid=rowid
  );
  ```
  Triggers on `unified_memories` INSERT/UPDATE/DELETE keep the FTS5 index in sync automatically. BM25 scoring via SQLite's built-in `bm25()` function with default parameters (k1=1.2, b=0.75).

- **Query embedding**: On `memorySearch`, embed the search query string using the same model. This is a single inference call (~30ms) — acceptable latency for a search operation.

- **Hybrid score formula**: Replace the current 40% lexical weight in composite scoring with a blended hybrid score:
  ```
  hybrid_score = 0.30 * bm25_normalized + 0.70 * cosine_similarity
  ```
  The remaining composite weights stay the same:
  ```
  final_score = 0.40 * hybrid_score
              + 0.20 * recency_score
              + 0.15 * importance_score
              + 0.15 * confidence_score
              + 0.10 * access_frequency_score
  ```
  BM25 normalization: raw BM25 scores are unbounded, so normalize to [0, 1] using `score / (score + k)` where k is calibrated from the result set (use the median score as k).

- **MMR re-ranking** (Maximal Marginal Relevance): After retrieving the top-N candidates by `final_score`, re-rank using MMR to reduce redundancy:
  ```
  MMR(d) = lambda * sim(query, d) - (1 - lambda) * max(sim(d, d_already_selected))
  ```
  Lambda = 0.7 (favor relevance, penalize near-duplicates). Applied as a greedy selection pass over the candidate set. The `sim` function is cosine similarity between embedding vectors.

- **Fallback**: If embeddings are unavailable for any entry (null embedding, pipeline disabled, backfill incomplete), that entry falls back to BM25-only scoring with the same composite formula. If the entire embedding pipeline is disabled, the system falls back to the current lexical/composite scoring — identical to the shipped W6 behavior. No degradation for users who never enable embeddings.

##### Renderer

- **Embedding health indicator**: Memory health dashboard in Settings > Memory gains an "Embeddings" section showing:
  - Progress: "X / Y entries embedded" with a progress bar during backfill.
  - Model status: "all-MiniLM-L6-v2 loaded" / "Model unavailable — [download] / [reason]".
  - Last embedding batch: timestamp and entries processed.
  - Cache stats: cache size, hit rate since startup.
- **Search quality toggle**: Memory inspector search gains a mode selector: "Lexical only" / "Hybrid (recommended)". Defaults to "Hybrid" when embeddings are available. This lets users compare results and debug retrieval quality.
- **Embedding column in memory table**: Optional "Embedded" column (checkmark/dash) in the memory entry list, showing which entries have vectors.

##### Service Architecture

```
embeddingService.ts          — Model loading, inference, cache management
embeddingWorkerService.ts    — Background queue processor, backfill, rate limiting
hybridSearchService.ts       — FTS5 + vec_distance_cosine fusion, MMR re-ranking
```

All three services instantiated in `main.ts` and injected into `unifiedMemoryService` as optional dependencies. If embedding services are unavailable, `unifiedMemoryService` continues with its current lexical path unchanged.

**Implementation status:** Not started.

**Tests:**
- sqlite-vec extension loading: verify `vec0` table creation, `vec_distance_cosine()` returns correct similarity for known vectors, extension loads on all supported platforms.
- Embedding model: load GGUF weight file, produce 384-dim vector from test string, verify deterministic output (same input → same vector), graceful error when weight file missing.
- Embedding cache: cache hit returns stored vector without inference, cache miss triggers inference and stores result, cache keyed by `sha256(content)`, cache survives service restart.
- Background embedding job: new `memoryAdd` entry appears in queue, batch processing embeds entries and writes to both tables, backfill on startup detects unembedded entries.
- Graceful degradation: embedding pipeline disabled → `memorySearch` returns lexical-only results, embedding failure for single entry → entry still searchable via lexical, model load failure → warning logged and pipeline disabled.
- Hybrid retrieval: search with embeddings returns semantically relevant results that lexical search misses (e.g., synonym matching), BM25 normalization produces scores in [0, 1], composite formula weights sum to 1.0.
- MMR re-ranking: result set with near-duplicate entries is de-duplicated, lambda=0.7 preserves relevance ordering while removing redundancy, MMR with single result is identity.
- FTS5 sync: insert into `unified_memories` → FTS5 index updated, update content → FTS5 re-indexed, delete → FTS5 entry removed.
- Renderer: embedding progress bar shows correct X/Y counts, search toggle switches between lexical and hybrid modes, health indicator reflects model status.
