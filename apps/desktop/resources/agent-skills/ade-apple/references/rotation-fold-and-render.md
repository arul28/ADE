# Rotation, folding and 3D renders

- Orientation: `rotate landscape-left` (also `portrait`,
  `portrait-upside-down`, `landscape-right`). **Read the answer.** `rotate`
  turns the device and then reads the screen, so `applied: true` means the
  framebuffer was seen on the requested axis — not that a request was sent.
  iOS always accepts the device orientation and then lets the foreground app
  decide, so `applied: false` with `reason: APPLE_ROTATE_NOT_ADOPTED` means
  that app kept its own orientation. The Home Screen and Settings are
  portrait-only on an iPhone, and no iPhone supports portrait upside down —
  put the app you are testing in front before you rotate, and do not treat a
  refusal as a broken simulator. `verification: already-on-axis` means the
  screen was on that axis before you asked; turning within one axis leaves
  the pixel size unchanged, so the exact side is not confirmed.
  On an iPhone Duo, `rotate` names how the PHONE is held, not the shape of
  the picture, and the inner display runs a quarter turn from the phone:

  | You want (inner display) | Do | Screenshot |
  |---|---|---|
  | Wide, flat open | `fold open` (or, already flat open, `rotate portrait`) | 2853x2007 |
  | Tall (upright), flat open | `fold laptop`, then `fold --angle 180` (or, already flat open, `rotate landscape-left`) | 2007x2853 |
  | Laptop (half open, tall) | `fold laptop` | 2007x2853 |
  | Book (half open, wide) | `fold book` | 2853x2007 |

  `rotate`, `fold` and `posture` print `picture inner display, tall|wide`;
  trust that line over the orientation name. A raw `fold --angle` keeps how
  the phone is held; `fold open` and `rotate portrait` turn it back to wide.
  The cover's Home Screen is portrait-only.

- Folding (iPhone Duo only): `fold closed|open|laptop|book|tent` or
  `fold --angle 120`, then read `posture` back. The answer is what the
  simulator did: `activeScreenId` 1 is the cover, 3 the inner display, and the
  live view, taps and typing follow it. On any other device it answers
  `supported: false`. Test a layout in more than one pose, and fold during a
  session, not only at launch. For a demo, `fold --sequence closed,open,tent`
  inside a recording adds a caption per pose. Tent reads `orientation
  facedown, tableMode yes, activeScreenId 1`: that is Device Hub's Tent (the
  phone stands on its outer edges, the cover faces the viewer), not a fault.
  Screenshots are the panel's own pixels and look the same in book, laptop
  and tent; to show the fold itself, `render --poses`.

- Getting an app ready for the Duo: `duo-skill` copies Apple's
  `app-resizability` skill (from Xcode 27) into the lane's
  `.agents/skills`; read it and follow it. It moves a UIKit app onto the scene
  life cycle (iOS 27 SDK apps without one do not launch) and off
  `UIScreen.main`, the idiom and the interface orientation. Then prove it:
  `fold closed`, `screenshot`, `fold open`, `screenshot`, without relaunching.
  It stops to ask whether the scene setup goes in Info.plist or code.

- 3D renders: `render --angles front,three-quarter-left --poses closed,open`
  (`--lighting studio|dusk`, `--sheet`, `--video`, `--no-shadow`) files stills
  of the 3D device with its live screen to the proof drawer. No pane needs to
  be open: any ADE desktop window with the project open renders it off
  screen (a project on another machine must be the window's front tab);
  with none, it says so. The device must be on (`apple start`). On a
  Duo each pose folds the simulator first. It prints a `cite:` line per
  image; paste them to show the renders.
