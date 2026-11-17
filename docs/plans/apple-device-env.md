# Apple device environment: agent contracts

The Apple Development tool is built. Its behavior, surfaces and source map are
in [docs/features/apple-device/README.md](../features/apple-device/README.md).
This file keeps the agent-facing contracts that code comments point to (§5)
and the owner's decisions (§6).

## 5. Agent-facing changes

The CLI is `ade apple`. The agent skill is `ade-apple`.

### New verbs

```bash
ade --socket apple device-create [--from <simulator>] [--name <name>] --text
ade --socket apple device-attach --simulator <udid|name> --text
ade --socket apple device-list [--installed] [--lane] --text
ade --socket apple device-delete [--force] --text

ade --socket apple record-start [--overlays on|off] [--label <text>] --text
ade --socket apple record-stop [--keep|--discard] --text
ade --socket apple record-list --text
ade --socket apple record-delete --id <id> --text

ade --socket apple frame [--out <path>] --text
```

- `device-create` with no `--from` clones the project's last-used installed
  simulator, else the newest installed iPhone. It never downloads a runtime; with
  none installed it fails with `APPLE_NO_INSTALLED_SIMULATORS` and a hint naming
  Xcode ▸ Settings ▸ Components.
- `device-attach` binds an existing simulator to the lane without cloning.
  `device-delete` refuses an attached device unless `--force`, and `--force` only
  detaches it — ADE never deletes a simulator it did not create.
- `device-list --installed` is what a human-facing picker shows;
  `device-list --lane` is the one device this lane owns.
- `frame` grabs a single decoded frame from the running stream — cheaper than
  `screenshot`, which round-trips `simctl`. `frame` fails when the stream is not
  running; `screenshot` does not need one.
- `record-stop --discard` is only permitted for a recording this chat owns and
  that is not marked `proof`.

### Auto-record contract

1. An agent's first injected input (`tap`, `tap-element`, `type`, `fill-element`,
   `drag`, `select`, `open-url`) against a device with no running recording
   **starts one automatically**, tagged `auto`, owned by the calling chat, with
   overlays per Settings.
2. It stops at the end of the chat's turn, or after 10 minutes, whichever comes
   first. `record-start` while an auto recording is running converts it to a
   manual one (no restart, no gap) and clears the 10-minute cap.
3. An agent may `record-delete` a recording it owns and did not mark `proof`.
   Anything else is refused with `APPLE_RECORDING_PINNED`.
4. `proof-bundle` pins the active recording — or the most recent one from this
   chat if none is active — copies it to the proof drawer, and makes it
   undeletable by any agent.
5. There is **no auto-delete**. Recordings accumulate until the user clears
   unpinned ones from the drawer's Recording section.
6. The verbs report ownership the same way sessions do, so a second chat sees
   `APPLE_OWNED_BY_OTHER_SESSION` with the owning chat, lane, and age — the
   existing cooperative-guard language, unchanged.

---

## 6. Decisions on the open questions (2026-09-21)

1. **Body models.** Bundle the GLB files in the app. Licensing is accepted as an
   open-source risk to fix later if asked.
2. **Recording retention.** No auto-delete. The Diagnostics/Storage section warns
   at a size ceiling. It warns only; it never deletes.
3. **`ade ios-sim` alias window.** One minor release. The published `@ade-dev`
   SDK carries both names for that window.
4. **Preview Lab.** Stays a mode toggle in the Apple column header.
5. **Two devices in one lane.** One at a time, with the "Replace?" prompt. No
   device switcher in the first version.
6. **Watch simulators.** Listed disabled with "Watch support is coming".
