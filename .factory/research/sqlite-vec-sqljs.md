# Research: sqlite-vec + sql.js Compatibility

## Key Finding: sqlite-vec CANNOT work with sql.js

sqlite-vec requires native SQLite `loadExtension()` which is unavailable in WASM builds. The official docs state: "It's not possible to dynamically load a SQLite extension into a WASM build of SQLite."

ADE uses sql.js ^1.13.0 (WASM-based SQLite).

## Alternatives Considered

1. **Pure JS/TS cosine similarity (CHOSEN)** — Store embeddings as BLOBs in regular sql.js tables, compute distances in TypeScript. Works with existing sql.js setup. O(n) brute-force scan is fine for <100K vectors (<50ms on modern hardware).

2. **sqlite-vec-wasm-demo** — Custom WASM build with sqlite-vec baked in. Requires separate SQLite instance. Package labeled as unstable ("may change at any time"). Rejected.

3. **@dao-xyz/sqlite3-vec** — Unified package but still requires separate DB. Rejected.

## FTS5 Also Unavailable

sql.js default build includes FTS3 but NOT FTS5. PR #594 to add FTS5 is still open/unmerged. Maintainer concerns about WASM size increase.

## Chosen Approach
- FTS3 + matchinfo() for BM25 keyword scoring
- Pure TypeScript cosine similarity for vector search
- Embeddings stored as BLOBs in regular tables via sql.js
