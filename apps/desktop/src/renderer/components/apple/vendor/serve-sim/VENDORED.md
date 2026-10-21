# Vendored: serve-sim's iPhone Duo model binding

| | |
|---|---|
| Upstream | https://github.com/expo/expo-device-hub (`packages/serve-sim/packages/serve-sim/src/client/simulator/`) |
| Commit | `2dbd92873b6ce44722cb0d283c70bd2684172c63` |
| Retrieved | 2026-10-21 |
| Licence | Apache License 2.0 (`LICENSE` here) |

| File | Upstream file | ADE patch |
|---|---|---|
| `devicekitUsdz.ts` | `devicekit-usdz.ts` | Imports use `three/examples/jsm/…` (ADE's style). |
| `duoModel.ts` | `duo-model.ts` | `loadDuoModel(bytes)` takes the archive's bytes from ADE's `ios_simulator.getDuoModel` instead of fetching a serve-sim endpoint. |
| `three-usd.d.ts` | — | ADE's: declarations for three's untyped USD modules. |

Apple's `V68.usdz` itself is never bundled or copied: it is read at runtime from the Xcode installed on the machine that owns the simulator.
