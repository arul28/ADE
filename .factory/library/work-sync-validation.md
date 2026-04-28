## Work sync parity validation notes

- `npm --prefix apps/desktop run test -- --maxWorkers=7` currently fails in this repo because the bundled Vitest/CAC CLI rejects `--maxWorkers` as an unknown option. Use targeted desktop tests without that flag unless the script is updated.
- Broad desktop `npm --prefix apps/desktop run typecheck` remains red in unrelated areas on this branch (`main.ts`, `linearDispatcherService`, `syncHostService`, `LinearConnectionPanel`), so Work sync contract changes should rely on targeted desktop coverage plus desktop build/lint unless those areas are part of the feature.
