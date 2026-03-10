# Research: @huggingface/transformers in Electron

## Package
- `@huggingface/transformers` v3.3.3 (stable)
- Formerly `@xenova/transformers`
- Uses `onnxruntime-node` for Node.js/Electron main process inference

## API for Embeddings
```typescript
import { pipeline } from '@huggingface/transformers';

const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
const output = await extractor('Your text here', { pooling: 'mean', normalize: true });
// output.data is Float32Array with 384 elements
```

## Model
- `Xenova/all-MiniLM-L6-v2` — 384 dimensions, ~80MB ONNX model
- Downloaded on first use, cached in app data directory
- Deterministic: same input → same vector

## Electron Bundling Gotchas
1. `onnxruntime-node` is a native module — needs `electron-rebuild`
2. Must be marked as `external` in tsup config (not bundled into JS output)
3. Must be excluded from asar packaging
4. Model files downloaded to `app.getPath('userData')` cache directory
5. Run inference in main process (not renderer) to use onnxruntime-node

## Performance
- ~20-80ms per entry on Apple Silicon
- Model load time: ~1-3 seconds on first call
- Subsequent calls reuse loaded model

## Graceful Degradation
If onnxruntime-node fails to load or model download fails:
- Log warning
- Disable embedding pipeline
- All memory operations continue via lexical search
- Health dashboard shows status and reason
