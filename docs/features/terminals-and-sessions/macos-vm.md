# macOS VM

Boot a clean macOS guest, on demand, for the active lane. Backed by Apple's
[Virtualization framework](https://developer.apple.com/documentation/virtualization)
via a Swift helper process; the renderer is a state machine that picks
between an onboarding wizard, an empty state, transient screens, a steady-state
cockpit, and concurrency overlays.

The feature is **Apple silicon + macOS 13 only**. It exists so a lane can run
build/integration steps inside an isolated guest with the host's source tree
auto-mounted via VirtioFS.

---

## State map

The Mac VM tab routes through twelve states. The first three are screens; the
next seven are lane-VM lifecycle states; the last two are sticky overlays that
can ride on top of any of D / E / F / G / H / I / J.

```
                     ┌── status.supported = false ──> A. UNSUPPORTED HOST
                     │
                     ├── provider unavailable ──────> B. PROVIDER UNAVAILABLE
                     │
   open VM tab ──────┼── no snapshot ready ─────────> C. ONBOARDING WIZARD
                     │
                     ├── snapshot ready, no laneVm ─> D. EMPTY (start CTA)
                     │
                     ├── laneVm.state = ...
                     │     creating | installing ───> E. PROVISIONING
                     │     starting ────────────────> G. STARTING (transient)
                     │     running ─────────────────> H. RUNNING COCKPIT
                     │     stopping ────────────────> I. STOPPING (transient)
                     │     stopped | paused ────────> F. STOPPED COCKPIT
                     │     failed ─────────────────-> J. FAILED
                     │
                     └── overlays:
                           K. CROSS-LANE BANNER (sibling lane has running VM)
                           L. GLOBAL RUNNING-VMs BAR (≥ 2 VMs running)
```

| State | Component | When it appears |
|-------|-----------|-----------------|
| A | `UnsupportedHost.tsx` | `status.supported === false` (e.g. Intel Mac) |
| B | `ProviderUnavailable.tsx` | `status.activeProvider.available === false` |
| C | `MacosVmOnboarding.tsx` | No bases in `state === "ready"` |
| D | `MacosVmEmpty.tsx` | Snapshot ready, no `laneVm` for this lane |
| E | `MacosVmProvisioning.tsx` | `laneVm.state` is `creating` or `installing` |
| F | `MacosVmStopped.tsx` (thin wrapper around `MacosVmCockpit`) | `laneVm.state` is `stopped` or `paused` |
| G | `MacosVmTransient.tsx` (variant `starting`) | `laneVm.state === "starting"` |
| H | `MacosVmCockpit.tsx` | `laneVm.state === "running"` |
| I | `MacosVmTransient.tsx` (variant `stopping`) | `laneVm.state === "stopping"` |
| J | `MacosVmFailed.tsx` | `laneVm.state === "failed"` |
| K | `MacosVmCrossLaneBanner.tsx` | Another lane has a VM in `running` / `starting` / `installing` |
| L | `MacosVmRunningBar.tsx` | `≥ 2` VMs across all lanes have `state === "running"` |

The router lives in
`apps/desktop/src/renderer/components/terminals/MacosVmPanel.tsx`. It
subscribes to `window.ade.macosVm.getStatus` + `onEvent`, picks the screen,
and renders K/L as sticky siblings above the body.

---

## Snapshot vocabulary

A **snapshot** is a fully-configured macOS bundle (`disk.img`,
`auxiliary-storage.bin`, `machine-identifier.bin`, `hardware-model.bin`,
config JSON) sitting in the bases directory with `state: "ready"`. Future
lane VMs are made by **APFS clonefile-cloning** the bundle (`cp -cR`,
copy-on-write) into a per-lane directory and booting from there. Cloning is
near-instant; a fresh lane VM is up in roughly 30 seconds.

Apple's framework also exposes `VZVirtualMachine.saveMachineStateTo` /
`restoreMachineStateFrom` (macOS 14+, gated by `validateSaveRestoreSupport()`).
That mechanism is for **suspend-to-disk of one VM**, not for making N
identical clones from a configured base. ADE deliberately uses disk-level
cloning instead, because the goal is multi-instance reuse, not pause/resume
of the same instance.

Naming everywhere user-facing — wizard step labels, cockpit drawer, save
dialog, picker dropdown — uses **"snapshot"**. The internal type is still
`MacosVmBaseRecord` in `apps/desktop/src/shared/types/macosVm.ts`; that's
intentional API compat and not user-visible.

---

## Onboarding wizard

`MacosVmOnboarding.tsx` is a full-screen wizard with seven pages, six of
which are numbered ("Step 1 of 6" through "Step 6 of 6"); Welcome and Done
are unnumbered intro / outro pages. Progress dots render at the top.

| Page | What it does |
|------|--------------|
| Welcome (`StepWelcome`) | Hero + illustration. Single CTA: "Get started". |
| 1. System check (`StepSystemCheck`) | Probes Apple silicon, host macOS ≥ 13, helper availability, Screen Recording permission, free disk warning. Surfaces the macOS 14.2.x VirtioFS-quirk warning when host version matches `^14\.2(\.|$)`. Required rows must pass; warnings can be acknowledged via an "I've read the warnings, continue anyway" checkbox. |
| 2. Configure (`StepConfigure`) | Local form: snapshot name (default `macOS 26.3`), CPU (2–8), memory chips, disk size, display, and an "Advanced" reveal for IPSW path (default `latest`). |
| 3. Install (`StepInstall`) | Calls `createBase`, listens to `provision` / `install` events, renders the progress bar. Cancel runs `deleteBase({ force: true })` and returns to Configure. On completion, calls `startBase({ openDisplay: true })` and advances. |
| 4. First boot (`StepFirstBoot`) | Static text + `[Reopen VM window]` (calls `focusBaseWindow({ name })`) + `[I finished setup →]`. The user has to complete macOS Setup Assistant manually in the helper's NSWindow. |
| 5. Save snapshot (`StepSnapshot`) | Calls `stopBase({ name })`, optionally `renameBase({ from, to })` if the user changed the default snapshot name (`clean macOS 26.3`), then `markBaseReady({ name })`. |
| 6. Done (`StepDone`) | Single CTA: "Open VM for this lane". Calls `start({ laneId, fromBase: true, baseName, createIfMissing: true, openDisplay: true })`. |

**Setup Assistant requirement.** Apple provides no API to skip macOS Setup
Assistant on a fresh install — it always runs once on first boot of a new
guest. The wizard's First-boot step is the only manual point in the flow:
the user clicks through Setup Assistant in the helper-owned NSWindow,
returns to ADE, presses "I finished setup", and ADE captures the configured
disk as a snapshot. That snapshot is then cloned for every lane VM, so the
manual step happens **once per snapshot, not per lane**.

---

## Steady-state cockpit

`MacosVmCockpit.tsx` is the running/stopped surface. The same component
renders for `running`, `stopped`, and `paused` (the Stopped wrapper just
delegates).

Header strip:

- State pill (color + label, animated dot for transient states)
- VM name, lane name, uptime ("uptime hh:mm:ss") or "last ran X min ago"
- Primary actions:
  - **Bring VM window forward** (`focusWindow({ laneId })`) — visible primary when running, since the user's eyes are on the helper's NSWindow, not on ADE.
  - **Start VM** — visible primary when stopped.
  - **Stop**, **Save snapshot** (only enabled when stopped), **Restart**
- Resource summary (CPU / memory / disk max / display, IP + copy, SSH
  command + copy, share path)
- "Cloned from snapshot {name}" pill when the lane VM has a `fromBaseName`
  in metadata.

Drawers (collapsible via `CockpitDrawer`):

| Drawer | Contents |
|--------|----------|
| **Quick input** (open by default) | Type-into-VM input + Send button, Capture screenshot button. The captured screenshot renders inline; clicking inside the preview calls `selectPoint` with `coordinateSpace: "window"`, surfaces a chat-attachable `MacosVmContextItem`, and offers a "Click point" follow-up that runs `click`. |
| **Snapshots** | List of `status.bases`. Per-row name + default badge + state pill + size/date, plus rename and delete buttons. Top button: **"+ Save current VM as new snapshot"** (only enabled when `vm.state === "stopped"`). |
| **Resources** | Read-only summary with the note "Resource changes apply on the next VM start." |
| **SSH / IP** | IP + SSH command (with copy buttons). Empty-state hint points at System Settings → Sharing → Remote Login. |
| **Advanced** | Open VM viewer (focus window), Restart, Open bundle in Finder, Delete VM, and the raw `ade --socket macos-vm start --lane … --create --text` command for scripting. |

The Save dialog (modal) takes name + optional description, calls
`saveLaneVmAsSnapshot({ laneId, name, description })`. Default name is
`<clonedFromName> - <YYYY-MM-DD>`.

---

## Concurrency

ADE permits multiple lane VMs to run simultaneously and surfaces awareness
aggressively rather than serializing.

**Cross-lane banner (`MacosVmCrossLaneBanner.tsx`, state K).** Sticky pill
at the top of the VM tab body when **another** lane has a VM in `running`,
`starting`, or `installing`. Shows that lane's name + uptime and offers
**Switch lane** (calls `selectLane`), **Focus** (`focusWindow` for the
sibling), **Stop** (`stop` for the sibling), and a dismiss `×` that mutes
this banner for the current session.

**Global running-VMs bar (`MacosVmRunningBar.tsx`, state L).** Sticky strip
at the very top of the VM tab when `vms.filter(v => v.state === "running").length >= 2`.
One row per running VM with state dot, lane name, vCPU/memory, and per-row
**Focus**, **Stop**, **→ Switch** (the current lane omits the Switch button).

**ConcurrencyConfirmDialog (`ConcurrencyConfirmDialog.tsx`).** Modal that
fires before starting the second-or-later VM. `useStartLaneVm` consults
`summariseRunningResources(vms)` (running ∪ starting ∪ installing ∪
creating), totals CPU + memory after the pending start, and:

- **`totalAfter ≥ 2`** — amber dialog: "Another macOS VM is already running."
- **`totalAfter ≥ 4`** — red/severe dialog: "Your Mac will struggle." Copy
  warns about heavy fan use, slow input, and possible lockups.

The dialog lists each currently-running VM (lane + vCPU/memory) and offers
**Cancel** or **Start anyway**. Confirmation continues the start; cancel
aborts.

---

## Backend additions

Three small service methods were added on top of the existing surface to
support the wizard and cockpit. All live in
`apps/desktop/src/main/services/macosVm/macosVmService.ts` and are exposed
through `registerIpc.ts` + `preload.ts` as `window.ade.macosVm.*`.

| Method | Purpose |
|--------|---------|
| `focusBaseWindow({ name })` | Brings the helper's NSWindow forward for a **base** (not a lane VM). Used by the wizard's First-boot step, where the user is operating on a base bundle that has no lane association yet. Resolves the helper PID from the base bundle's `runtime-status.json`. |
| `saveLaneVmAsSnapshot({ laneId, name, description? })` | Snapshots a stopped lane VM as a new base. Mirrors `copyBundleFromBase` in reverse — clonefile the lane's bundle directory into a fresh base directory, write a new `MacosVmBaseRecord`, mark it `ready`. VM must be `stopped`. |
| `renameBase({ from, to })` | Renames a base in `bases.json` and renames the bundle directory on disk. Used by both the wizard's Save-snapshot step (when the user picks a non-default snapshot name) and the cockpit's per-snapshot rename action. |

Existing methods are unchanged: `getStatus`, `provision`, `start`, `stop`,
`delete`, `createBase`, `startBase`, `stopBase`, `markBaseReady`,
`deleteBase`, `focusWindow`, `captureScreenshot`, `click`, `typeText`,
`selectPoint`.

---

## Apple framework references

The native helper at
`apps/desktop/native/macos-vm-helper/macos-vm-helper.swift` drives the
guest. Relevant Apple APIs:

- **[`VZMacOSRestoreImage`](https://developer.apple.com/documentation/virtualization/vzmacosrestoreimage)**
  — `fetchLatestSupported` downloads the latest IPSW; `load(from:)`
  validates a user-supplied IPSW path.
- **[`VZMacOSInstaller`](https://developer.apple.com/documentation/virtualization/vzmacosinstaller)**
  — runs the install. Progress is observed via KVO on
  `progress.fractionCompleted` and forwarded as `provision` / `install`
  events to the renderer.
- **[`VZVirtioFileSystemDeviceConfiguration`](https://developer.apple.com/documentation/virtualization/vzvirtiofilesystemdeviceconfiguration)**
  — created with the static
  `VZVirtioFileSystemDeviceConfiguration.macOSGuestAutomountTag` so the
  shared host directory auto-mounts inside the guest at
  `/Volumes/My Shared Files`. Requires guest macOS 13+.
- **[`ScreenCaptureKit`](https://developer.apple.com/documentation/screencapturekit)**
  — used by the helper to capture VM-window screenshots for the Quick-input
  drawer (`SCScreenshotManager.captureImage`). Requires Screen Recording
  permission, which the wizard probes at System-check time by attempting a
  capture.

**macOS 14.2 / 14.2.1 VirtioFS bug.** On these specific host versions, the
guest's auto-mounted shared folder can disappear after the host wakes from
sleep. The wizard's System-check step detects host versions matching
`^14\.2(\.|$)` and surfaces a warning row. The recommended workaround is to
re-mount inside the VM (or upgrade the host beyond 14.2.1).

The VM's display + input is **not** embedded in Electron. The helper owns
its own `NSWindow`; ADE captures it via ScreenCaptureKit and posts
synthetic input through helper RPC. "Bring VM window forward" / "Focus"
buttons all route through the helper's `window-info --activate` command.

---

## Known follow-ups

These came out of the audit (#7 / #9 of the cleanup plan) and are minor
enough to ship later:

- **Override-warnings checkbox is wizard-only.** The System-check step lets
  the user acknowledge warning-tone rows via a checkbox before continuing;
  the equivalent acknowledgement does not exist in the steady-state Quick
  input or Resources surfaces. This is a documented deviation, not a bug —
  warnings outside onboarding don't block any action today.
- The **`SnapshotPicker`** is currently used in the Empty state only; the
  cockpit's Save dialog uses a free-text input instead of the picker. Worth
  consolidating later.

---

## Pointers

- Router: `apps/desktop/src/renderer/components/terminals/MacosVmPanel.tsx`
- States: `apps/desktop/src/renderer/components/terminals/macosVm/`
- Wizard: `apps/desktop/src/renderer/components/terminals/macosVm/MacosVmOnboarding.tsx` and `wizardSteps/`
- Tab dot: `apps/desktop/src/renderer/components/terminals/macosVm/macosVmTabDot.tsx` (consumed by `WorkSidebar.tsx`)
- Backend: `apps/desktop/src/main/services/macosVm/macosVmService.ts`
- Native helper: `apps/desktop/native/macos-vm-helper/macos-vm-helper.swift`
- Shared types: `apps/desktop/src/shared/types/macosVm.ts`
