# Android emulator: open work

The Android Development tool is built (phases P0 to P3). Its behavior,
surfaces and source map are in
[docs/features/android-device/README.md](../features/android-device/README.md).
This file holds only the open work.

## Open items

- No GLB model files ship yet. Every catalog device uses the procedural body
  (see §7).
- The phone viewer does not fold yet. Phone fold mirroring waits for a host
  posture API.
- Android on ADE Cloud comes later. The Android pane shows on ADE Cloud with
  the right state; it is never hidden.

## 7. 3D models

- Source, in order: (1) Google's own 3D/AR product files, if the Google Store
  or Google's AR viewer loads GLBs (the store HTML has no direct links; check
  the page's network requests in a browser); (2) Samsung's AR product files,
  same check; (3) paid marketplace packs with GLB (CGTrader lists a Pixel 10
  series pack and a Pixel 9 pack with the 9 Pro Fold); (4) free CC models on
  Sketchfab.
- Target set: a current Pixel phone, a Pro size, the Pro Fold (two panels and a
  hinge, reusing the Duo posture pipeline), a Pixel Tablet, and one non-Pixel
  phone. Record each model's source, licence and checksum in a
  `sources.json`, as the iPhone models do.
- Each model needs a named screen mesh; the loader maps the live frame onto it
  (`appleDeviceScene.ts` pattern). A profile with no model gets the procedural
  body, sized from the profile's screen size, aspect and corner radius.
- Licence risk is accepted for now by the owner. The iPhone GLBs carry the same
  open question (`assets/apple-device-models/sources.json`). Brand logos have
  the same status: record them in `sources.json`; each is an easy removal.

### 7.1 Brand catalog

- **First set:** Pixel 10, Pixel 10 Pro, Pixel 10 Pro Fold, Pixel Tablet,
  Pixel Watch; Galaxy S25, Galaxy S25 Ultra, Galaxy Z Fold; one or two more
  brands (OnePlus or Nothing).
- **Entry:** name, brand, logo, hardware profile ID, model file, colour
  options (body materials), screen size line.
- **Pixel profiles** come from the SDK (`pixel_9_pro_fold` and `pixel_tablet`
  exist on the owner's Windows SDK; read the newest Pixel IDs at runtime and
  fall back to the nearest one).
- **Non-Pixel profiles:** ADE writes a hardware profile (`ade_<model>`) with
  the true screen size, resolution and density from the spec sheet. ADE
  writes it to the user's own device definitions and never edits SDK files.
- **Colour choice:** the body uses the colour picked on the tile. Models need
  a separate body material.
