# Android emulator: open work

The Android Development tool is built (phases P0 to P3), including on DAEX
Cloud computers. Its behavior, surfaces and source map are in
[docs/features/android-device/README.md](../features/android-device/README.md).
This file holds only the open work.

## Open items

- No GLB model files ship yet. Every catalog device uses the procedural body
  (`renderer/components/device/proceduralFoldBody.ts` for foldables).
- The phone viewer (iPhone app) does not fold yet.

## 3D models

- Source, in order: (1) Google's own 3D/AR product files, if the Google Store
  or Google's AR viewer loads GLBs (check the page's network requests);
  (2) Samsung's AR product files, same check; (3) paid marketplace packs with
  GLB (CGTrader has Pixel 10 and Pixel 9 Pro Fold packs); (4) free CC models
  on Sketchfab.
- Target set: a current Pixel phone, a Pro size, the Pro Fold (two panels and
  a hinge, reusing the posture pipeline), a Pixel Tablet, and one non-Pixel
  phone. Record each model's source, licence and checksum in a
  `sources.json`, as the iPhone models do
  (`apps/desktop/src/renderer/assets/apple-device-models/sources.json`).
- Each model needs a named screen mesh; the loader maps the live frame onto it
  (`renderer/components/device/deviceModelLoader.ts`, `deviceScene.ts`). A
  profile with no model keeps the procedural body, sized from the profile's
  screen size, aspect and corner radius (`androidDeviceModels.ts`).
- Licence risk is accepted for now by the owner, as for the iPhone GLBs.
  Brand logos have the same status: record them in `sources.json`.

### Brand catalog

- **First set:** Pixel 10, Pixel 10 Pro, Pixel 10 Pro Fold, Pixel Tablet,
  Pixel Watch; Galaxy S25, Galaxy S25 Ultra, Galaxy Z Fold; one or two more
  brands (OnePlus or Nothing).
- **Entry:** name, brand, logo, hardware profile ID, model file, colour
  options (body materials), screen size line.
- **Pixel profiles** come from the SDK; read the newest Pixel IDs at runtime
  and fall back to the nearest one.
- **Non-Pixel profiles:** DAEX writes a hardware profile (`ade_<model>`) with
  the true screen size, resolution and density from the spec sheet, to the
  user's own device definitions. It never edits SDK files.
- **Colour choice:** the body uses the colour picked on the tile, so models
  need a separate body material.
