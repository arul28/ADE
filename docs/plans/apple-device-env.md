# Apple device environment: agent contracts

The Apple Development tool is built. Its behavior, surfaces and source map are
in [docs/features/apple-device/README.md](../features/apple-device/README.md).
This file keeps the agent-facing contracts that code comments point to (§5)
and the owner's decisions (§6).

## 5. Agent-facing contracts

The CLI is `daex apple` (`ade apple` still works). The agent skill is
`daex-apple`.

### Verbs

```bash
daex apple device-create [--from <simulator>] [--name <name>] [--extra] --text
daex apple device-attach --simulator <udid|name> --text
daex apple device-list [--installed] [--runtimes] [--disk] --text
daex apple device-delete [--device <udid|name>] [--force] --text

daex apple record-start [--overlays on|off] [--label <text>] [--plain|--zoom] [--max-seconds <n>] --text
daex apple record-stop [--keep|--discard] --text
daex apple record-list --text
daex apple record-delete --id <id> --text
daex apple auto-record on|off --text

daex apple frame [--out <path>] --text
```

- `device-create` with no `--from` clones the project's last-used installed
  simulator, else the newest installed iPhone. It never downloads a runtime;
  with none installed it fails with `APPLE_NO_INSTALLED_SIMULATORS` and a hint
  naming Xcode > Settings > Components.
- `device-attach` binds an existing simulator to the lane without cloning.
  `device-delete` refuses an attached device unless `--force`, and `--force`
  only detaches it: DAEX never deletes a simulator it did not create.
- `frame` grabs one decoded frame from the running stream, cheaper than
  `screenshot` (which round-trips `simctl`). `frame` fails when the stream is
  not running; `screenshot` does not need one.
- `daex ios-sim` is a deprecated alias of `daex apple` and prints a warning.

### Auto-record contract

The source of truth is the header of
`apps/desktop/src/main/services/ios/recording/simRecordingService.ts`. In
short:

1. An agent's first input on a device with no running recording starts one,
   tagged `auto` and owned by the calling chat, unless the caller opted out
   (`--no-record` on the call, `auto-record off` on the lane, or the
   machine's `apple.autoRecordAgentInput` setting off). A person driving the
   pane never starts one.
2. It stops at the end of that chat's turn (`agentChatService.ts` notifies at
   every turn's end) or after five minutes. `record-start` while an auto
   recording runs converts it to a manual one with no gap.
3. No recording runs longer than five minutes, and one with no input for two
   minutes or that fills the disk stops too (`demoRecordingGuard.ts`).
4. Every recording that stops is turned into a short demo video and filed into
   the proof drawer at once, attributed to the owning chat.
5. An agent may delete a recording it owns but not one filed as proof
   (`APPLE_RECORDING_PINNED`); another chat's recordings are refused with
   `APPLE_OWNED_BY_OTHER_SESSION`.
6. There is no auto-delete. The storage warning (`apple.recordingsWarnBytes`)
   only warns.

The lane's Android emulator follows the same contract (`androidAutoRecord.ts`).

## 6. Owner decisions (2026-09-21)

1. **Body models.** GLB files ship in the app. Licensing is an accepted risk
   (`apps/desktop/src/renderer/assets/apple-device-models/sources.json`).
2. **Recording retention.** No auto-delete; a size warning only.
3. **Preview Lab.** Lives in the pane's tools drawer
   (`apple/drawer/AppleToolsDrawer`), not a separate mode.
