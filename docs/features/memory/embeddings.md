# Embeddings and Semantic Retrieval

ADE ships with an optional local embedding model that powers
meaning-based memory search and the consolidation clustering pipeline.
Embeddings are produced in-process by a Transformers.js runtime; no
memory data is sent externally for vectorisation.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/memory/embeddingService.ts` | Loads the Transformers.js pipeline, embeds text, exposes status and cache. |
| `apps/desktop/src/main/services/memory/embeddingWorkerService.ts` | Background worker: pulls unembedded memories, generates vectors, writes to `unified_memory_embeddings`. |
| `apps/desktop/src/main/services/memory/hybridSearchService.ts` | BM25 + cosine similarity + MMR re-ranking. Used by `memoryService.search` when embeddings are available. |
| `apps/desktop/src/main/services/state/kvDb.ts` | `unified_memory_embeddings` schema. |

## Model

- Id: `Xenova/all-MiniLM-L6-v2`
- Dimensions: 384
- Task: `feature-extraction`
- Runtime: Transformers.js (`@xenova/transformers`), ONNX model
  executed locally.
- Required model files: `config.json`, `tokenizer.json`,
  `tokenizer_config.json`, `onnx/model.onnx`.

Model files are downloaded to a cache directory (`app.getPath("userData") / models /`)
on first use. `ade.memory.downloadEmbeddingModel` triggers an explicit
download; otherwise the pipeline downloads on-demand when first asked
to embed.

## Service lifecycle

`EmbeddingServiceStatus`:

```ts
{
  modelId: string;
  cacheDir: string;
  installPath: string;
  installState: "missing" | "partial" | "installed";
  state: "idle" | "loading" | "ready" | "unavailable";
  activity: "idle" | "loading-local" | "downloading" | "ready" | "error";
  progress: number | null;   // 0..1 during download
  loaded: number | null;
  total: number | null;
  file: string | null;       // file currently loading/downloading
  error: string | null;
  cacheEntries: number;
  cacheHits: number;
  cacheMisses: number;
}
```

State transitions: `idle -> loading -> ready | unavailable`. Once
`ready`, embeddings run synchronously (CPU-bound but fast for short
content). When `unavailable`, search falls back to lexical FTS and the
hybrid search service refuses to run.

### In-memory cache

`MAX_EMBEDDING_CACHE_SIZE = 5000` LRU entries keyed by content hash.
Cache hits avoid re-embedding the same content; important for
consolidation where clusters iterate over the same entries.

### Smoke test

On model load, the service embeds `"ADE embedding verification probe"`
and checks the result has `EXPECTED_EMBEDDING_DIMENSIONS = 384`.
Failures move the service to `unavailable` rather than silently
producing bad vectors.

## Embedding worker

`embeddingWorkerService.ts` is the background loop that reconciles
`unified_memories` with `unified_memory_embeddings`.

### Batch sizes

- `DEFAULT_IDLE_BATCH_SIZE = 50` when no active chat sessions.
- `DEFAULT_ACTIVE_BATCH_SIZE = 10` when chat is active (reduces
  contention).
- Clamped to `[MIN_BATCH_SIZE=10, MAX_BATCH_SIZE=50]`.
- Yields `DEFAULT_YIELD_MS = 100 ms` between batches to avoid blocking
  the event loop.

### Worker status

```ts
type EmbeddingWorkerStatus = {
  started: boolean;
  queueDepth: number;
  processing: boolean;
  batchesProcessed: number;
  embeddingsWritten: number;
  failedEntries: number;
  lastBatchSize: number;
  maxBatchSizeObserved: number;
  lastProcessedAt: string | null;
};
```

### Queue drain

When the embedding service starts in `loading` state, incoming
`memoryAdd` calls leave rows in `unified_memories` without embeddings.
The worker detects these on the next tick and processes them once the
model is `ready`. Missing this path would silently drop embeddings for
rows created during model load.

## Vector storage

```sql
create table unified_memory_embeddings (
  id text primary key,
  memory_id text not null,
  project_id text not null,
  embedding_model text not null,
  embedding_blob blob not null,    -- Float32, 384 dims = 1536 bytes
  dimensions integer not null,
  norm real,                       -- precomputed L2 norm for cosine
  created_at text not null,
  updated_at text not null
);
```

`norm` is precomputed at write time so cosine similarity does not need
to recompute `sqrt(sum(x^2))` at query time.

Model changes: if `embedding_model` in a row does not match the
current service's `modelId`, the hybrid search service treats the row
as stale and does not use its vector for cosine similarity. The worker
re-embeds stale rows on the next pass.

## Hybrid search

`hybridSearchService.ts` combines BM25 (lexical) and cosine similarity
(vector) scores with MMR (Maximal Marginal Relevance) re-ranking for
diversity.

### Constants

```ts
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const MMR_LAMBDA = 0.7;
const MIN_VECTOR_RESULTS = 40;
```

- `BM25_K1`, `BM25_B` -- standard Okapi BM25 parameters.
- `MMR_LAMBDA = 0.7` -- weight between relevance (lambda) and
  diversity (1 - lambda). Higher values favor relevance.
- `MIN_VECTOR_RESULTS = 40` -- the vector candidate pool is filled to
  at least 40 before MMR selection so downstream filtering has
  headroom.

### Flow

1. Run FTS BM25 query (via `unified_memories_fts MATCH`) to get the
   top-K lexical candidates.
2. Run cosine similarity over the embedding table to get the top-K
   vector candidates.
3. Union the two candidate sets.
4. Compute a hybrid score as a weighted combination of normalised BM25
   and cosine.
5. Apply MMR to re-rank: each selection balances its hybrid score
   against similarity to already-selected candidates.
6. Apply final `limit` (default 5).

### Candidate shape

```ts
type HybridSearchCandidate = {
  memory: Memory;
  vector: Float32Array | null;
  hasEmbedding: boolean;
  bm25Score: number;
  bm25Normalized: number;    // 0..1
  cosineSimilarity: number;  // 0..1
  hybridScore: number;       // 0..1
  compositeScore: number;    // tier/confidence/pinned weighting
};
```

`compositeScore` blends pinned status, tier, confidence, and hybrid
score into a single ranking value. Pinned entries get a large boost;
Tier 1 > Tier 2 > Tier 3.

### Fallback

When the embedding service is `unavailable`, `hybridSearchService`
throws `HybridSearchUnavailableError`. `memoryService.search` catches
this and falls back to lexical FTS.

## Health monitoring

The embedding service and worker emit structured status events on
state transitions and every batch. The Settings -> Memory tab polls
`ade.memory.healthStats` every ~10 s and displays:

- Service state + activity.
- Download progress (loaded / total bytes, current file).
- Queue depth and processing rate.
- Cache hit/miss ratios.
- Error state and last error message.

`ade.memory.downloadEmbeddingModel` triggers an explicit download with
progress events. Useful for users on air-gapped or low-bandwidth
networks who want to preload the model.

## Privacy

The embedding model runs entirely locally:

- Transformers.js loads the ONNX model from the app cache directory.
- Embedding calls execute in the main process; no network involvement
  after the initial model download.
- Model files are cached under `app.getPath("userData")`.

External data flows: model files are downloaded from Hugging Face on
first install (or via `downloadEmbeddingModel`). This is the only
network path.

## Fragile and tricky wiring

- **Unknown tensor shape.** The Transformers.js pipeline may return
  either a raw `ArrayLike<number>` or an `EmbeddingTensorLike` with
  `data` and `dims`. The service normalises both; any new pipeline
  version that changes the shape again will regress.
- **Cache eviction is LRU on total size, not time.** Warming with
  many short strings can evict long ones even if they are still
  relevant. Consider cache-key tuning if cache hit rates drop.
- **`norm` must be kept in sync with `embedding_blob`.** Manual writes
  to the blob without updating `norm` break cosine similarity. Always
  go through the worker.
- **Hybrid score normalisation.** BM25 scores are normalised against
  the top result in the candidate set, not globally. Cross-project
  comparison is meaningless; only use scores within a single query.
- **MMR re-rank can exclude the top result.** At `lambda = 0.7`, if
  the top hybrid-score result is extremely similar to the query and
  the #2 result adds diversity, MMR may return the #2 before the #1.
  This is intentional for diversity; callers that want pure relevance
  should lower MMR lambda or bypass MMR.
- **Stale embedding model id.** When the model is upgraded, the worker
  detects the mismatch on the next pass and re-embeds. During the
  transition window, some rows use the old model and some the new.
  Cosine similarity across the boundary is meaningless; the hybrid
  service treats pre-upgrade embeddings as non-embedded until the
  worker catches up.
- **Smoke test uses a fixed string.** If Transformers.js introduces
  non-deterministic pooling for the `feature-extraction` pipeline,
  the dimensions check may pass but numeric equality tests fail.
  Currently the smoke test only checks dimensions.
- **The worker batch size is a trade-off.** Large batches produce
  embeddings faster but lock the event loop; small batches keep UI
  responsive but under-utilise the CPU. The idle/active bifurcation
  adapts, but heavy consolidation runs may still cause chat latency.

## Related docs

- [Memory README](README.md) -- overview.
- [Storage](storage.md) -- `unified_memory_embeddings` table.
- [Compaction](compaction.md) -- consolidation depends on embeddings.
</content>
</invoke>