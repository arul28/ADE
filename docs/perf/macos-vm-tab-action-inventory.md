# macOS VM tab action inventory

This is the audit matrix for the dedicated macOS VM tab. It is deliberately not
a completion claim: a row is only `measured` when a real ADE UI run or CLI probe
has evidence from the perf-pass repo. Rows that require a working provider stay
`blocked` until Lume is installed and a real VM can be provisioned.

Coverage states:

- `source`: found in source, not yet driven in the current inventory pass.
- `measured`: covered by a real UI run, UI-derived probe, CLI probe, or focused
  fixture test with evidence.
- `blocked`: ADE reached the action but the host/provider state prevented the
  next step.
- `fixture-needed`: safe to drive, but needs a seeded repo/lane/VM state.
- `destructive-prompt`: opens a destructive confirmation. Measure the
  preflight, then cancel unless explicitly allowed.

## 2026-05-16 audit pass

Evidence:

- Perf run: `/Users/admin/.ade/perf-runs/vm-ui-audit-20260516-131448/events.jsonl`
- Socket perf run:
  `/Users/admin/.ade/perf-runs/vm-ui-audit-socket-20260516-132600/events.jsonl`
- Sample repo: `/Users/admin/Projects/perf pass`
- Reset command: `PERF_PASS_FORCE=1 scripts/reset-perf-pass.sh "/Users/admin/Projects/perf pass"`
- Created lane: `vm audit local 20260516`
- Created branch: `ade/vm-audit-local-20260516-9f8d1a8c`
- Created worktree: `/Users/admin/Projects/perf pass/.ade/worktrees/vm-audit-local-20260516-9f8d1a8c`
- End-to-end perf run:
  `/Users/admin/.ade/perf-runs/vm-e2e-lume-20260516-133200/events.jsonl`
- VM lane, default image pass: `vm e2e. lume20260516`
  (`96242862-eedf-4f78-8218-067cd90e7ac7`,
  `ade/vm-e2e-lume20260516-96242862`)
- VM lane, CUA image retry: `vm e2e. cua20260516`
  (`866139e9-6202-4a51-a988-641d5898384c`,
  `ade/vm-e2e-cua20260516-866139e9`)
- Screenshot artifacts:
  `/Users/admin/Projects/perf pass/.ade/artifacts/macos-vms/96242862-eedf-4f78-8218-067cd90e7ac7/e2e-cdp-after-fix.png`,
  `/Users/admin/Projects/perf pass/.ade/artifacts/macos-vms/866139e9-6202-4a51-a988-641d5898384c/e2e-cua-after-wait.png`

Host/provider findings:

- Host architecture and OS are compatible with Apple Virtualization:
  `arm64`, macOS `26.3.1`.
- `lume` is not installed on this Mac, so the Lume provider reports unavailable.
- Lume was then installed as a Homebrew bottle at `/opt/homebrew/bin/lume`;
  `lume --version` reported `0.3.9`.
- No current ADE macOS VM records or leases were present to clear before retry:
  the checked current-lane, home, runtime-home, and Versic cache locations had no
  active `lease.json` or VM records.
- The first perf launch ran before the local-runtime-disable diagnostic mode was
  removed and did not enable the legacy desktop RPC socket, so UI proof is
  authoritative for that run. Socket-backed CLI evidence was collected from a
  second dev-desktop launch through
  `ADE_RPC_SOCKET_PATH=/tmp/ade-runtime-dev.sock`.
- The default `macos-tahoe-vanilla:latest` VM provisioned successfully but ADE's
  first start attempt timed out waiting for Lume to report `running`. A manual
  `lume run ... --no-display` started the same VM, and ADE then reconciled the
  page to `running`.
- The `macos-sequoia-cua:latest` image did not produce a VM under Lume `0.3.9`
  and left a partial `~/.lume/<vm-name>` directory that `lume delete --force`
  could not remove. Manual removal of that partial directory was required before
  retrying.
- The `macos-tahoe-cua:latest` image provisioned successfully and ADE's own
  start path succeeded with managed VNC credentials.
- Both the default Tahoe vanilla VM and the Tahoe CUA VM returned all-black VNC
  frames after reaching `running`; host-side click/type calls succeeded, but
  visual computer-use proof remains blocked until the provider exposes a usable
  desktop frame.
- Final cleanup removed both VM-backed lanes and provider VMs. After cleanup,
  `lume ls` returned no virtual machines, the ADE VM records file contained an
  empty `records` array, and `~/.lume` was back to `8.0K`.
- The direct RFB click path initially returned `0,0` because input could be sent
  before the VNC client learned the framebuffer size. The client now waits for a
  framebuffer size before clamping pointer coordinates.

Continuation evidence after the initial pass:

- Perf run: `/Users/admin/.ade/perf-runs/vm-visible-control-20260516-01/events.jsonl`
- VM lane created through the visible ADE lane modal:
  `vm visible control 20260516`
  (`d3a926cb-e807-4fcf-bb5a-972a11685849`,
  `ade/vm-visible-control-20260516-d3a926cb`)
- ADE start with `macos-tahoe-cua:latest`, `openDisplay: true`, and
  `display: 1280x720` provisioned and reported `running`, with VNC endpoint
  `127.0.0.1:59729`, but both ADE noVNC and macOS Screen Sharing showed an
  all-black frame after an extended first-boot window. `lume get` continued to
  report `ipAddress: null` and `sshAvailable: null`.
- ADE diagnostic screenshot:
  `/Users/admin/Projects/perf pass/.ade/artifacts/macos-vms/d3a926cb-e807-4fcf-bb5a-972a11685849/ade-perf-pass-vm-visible-control-20260516-d3a926cb-1778955980876.png`
  returned `imageState: blank`.
- The documented Cua prebuilt `macos-sequoia-cua:15.3` failed under Lume
  `0.3.9` with `Virtual machine not found: ade-perf-pass-vm-visible-control-20260516-d3a926cb`
  and left a partial `~/.lume/<vm-name>` directory that had to be removed
  manually after `lume delete --force` failed.
- The documented Lume IPSW/unattended path,
  `mode: create`, `ipsw: latest`, `unattendedPreset: tahoe`, installed
  `sshpass` successfully but failed before booting a visible desktop with
  `A software update is required to complete the installation. Installation requires a software update.`
  The host was macOS `26.3.1` (`25D2128`), and `softwareupdate -l` listed the
  recommended `macOS Tahoe 26.5-25F71` update plus Xcode Command Line Tools
  `26.5`.
- Cua's current docs list `macos-sequoia-cua:15.3` as the prebuilt image
  compatible with the Computer interface and say `lume run` should open a VNC
  window; they also document unattended Tahoe setup via VNC/OCR with `sshpass`
  required for the SSH health check.

Signed Lume / compatible IPSW continuation:

- The Homebrew `/opt/homebrew/bin/lume` binary was unsigned and did not carry the
  Apple Virtualization or VM networking entitlements needed for reliable visible
  macOS guests. ADE now prefers Cua's signed app bundle at
  `~/.local/share/lume/lume.app/Contents/MacOS/lume`, reports that selected path
  in the VM tab, and rejects unsigned Lume binaries before marking the provider
  ready.
- Cua's installer path is the portable path for ADE users: the signed app bundle
  and `~/.local/bin/lume` wrapper live under each user's home directory, while
  `ADE_LUME_PATH` remains available for intentional overrides.
- `lume ipsw` returned a Tahoe 26.5 restore image on this host, which triggered
  Apple's `A software update is required to complete the installation` failure.
  ADE now supports HTTP(S) IPSW inputs by downloading the restore image into the
  project cache with `curl --continue-at -`, then passing the local file to
  `lume create`; Lume `0.3.9` rejected a raw HTTPS URL with `IPSW file not
  found`.
- The compatible restore-image path tested here is Apple's Sequoia 15.6.1 restore image
  `UniversalMac_15.6.1_24G90_Restore.ipsw`, cached at
  `.ade/cache/macos-vms/ipsw/UniversalMac_15.6.1_24G90_Restore.ipsw`, created
  with `--display 1440x900`.
- The VM tab now defaults fresh starts to `mode: create` so ADE uses the cached
  restore-image path. The prepared-image pull path remains available in the
  service/API, but it is no longer the renderer default because the tested Tahoe
  images produced black frames on this Mac.
- ADE sets the default VM display to `1920x1440`, and still applies the record's
  display with `lume set <vm> --display <size>` before every `lume run`. The
  live verification used `1440x900` to fit the local viewer while proving the
  larger-than-Lume-default path works.
- Codex Computer Use attached to macOS Screen Sharing for the resulting VNC
  endpoint and confirmed a visible, controllable setup screen at 1440x900. The
  Cua `sequoia` unattended preset progressed through several setup screens, but
  missed later OCR/click steps (`Agree`, `Time Zone`, `Screen Time`, and finally
  `Choose Your Look`) and Lume deleted the VM when the preset failed. ADE should
  not treat that bundled unattended preset as the stable product path; the stable
  path is cached IPSW creation plus visible ADE/Screen Sharing control.
- Live signed-Lume verification then started
  `ade-perf-pass-vm-signed-lume-visible-1efa8906` from the cached Sequoia 15.6.1
  IPSW, attached ADE's embedded console and macOS Screen Sharing to
  `vnc://127.0.0.1:59735`, and captured a visible direct-VNC screenshot at
  `1440x900`:
  `/Users/admin/Projects/perf pass/.ade/artifacts/macos-vms/1efa8906-f83d-4354-a322-1fef1bb4f526/ade-perf-pass-vm-signed-lume-visible-1efa8906-1778969497741.png`.
- Re-running ADE's start action while the VM was already running did not open
  another Screen Sharing viewer when exactly one helper was connected. A later
  duplicate-client pass exposed two Screen Sharing PIDs attached to the same VNC
  port; ADE now treats that as unhealthy, closes/quits the helpers, and opens one
  fresh hidden helper.
- A pure hidden start using Lume's documented `run --no-display` flag avoided
  Screen Sharing entirely and still returned an ADE display session, but the
  direct-VNC frame was `imageState: blank` on this real Sequoia 15.6.1 VM. ADE
  therefore keeps `openDisplay: true` for the default renderer path and
  immediately minimizes the macOS Screen Sharing helper window instead of
  relying on pure no-display mode.
- The minimized-helper path was verified live after restart: ADE metadata set
  `externalVncClientHidden: true`, `lsof` showed Lume, Electron, and one Screen
  Sharing client on `127.0.0.1:59736`, and the Accessibility check for Screen
  Sharing returned `Virtualization, true`.
- A later stop/start exposed the next duplicate-window edge case: stale Screen
  Sharing helper processes can survive after Lume changes the VNC port. ADE now
  closes/quits stale `Virtualization` Screen Sharing helpers before opening the
  current helper, and also replaces duplicate helpers when more than one Screen
  Sharing client is connected to the current VNC port.
- Setup Assistant was completed through ADE's embedded/direct VNC controls, then
  Terminal inside the guest wrote `adevmroundtrip.txt` under
  `/Volumes/My Shared Files`. The same file appeared in the host lane worktree at
  `/Users/admin/Projects/perf pass/.ade/worktrees/vm-signed-lume-visible-1efa8906/adevmroundtrip.txt`,
  and ADE's files API listed it as an untracked text file and read back:
  `ade vm roundtrip from guest`.

## 2026-05-17 retry audit

- Cleared the stale ADE-owned VM infrastructure on the host before the retry:
  `ade-perf-pass-vm-signed-lume-visible-1efa8906` was deleted through
  `ade macos-vm delete --force`, the stale Lume run process was killed, stale
  perf-pass VM worktrees/branches were pruned, and `lume ls` returned no VMs.
  The perf-pass VM record store was empty afterward and `~/.lume` dropped back
  to cache-only size.
- Product lane deletion exposed a host cleanup bug: a guest-created
  unreadable `.Trashes` directory made manual stale-worktree removal fail with
  `EACCES`. `laneService.delete` now makes stale worktree trees writable before
  recovery removal, with regression coverage for VM guest-created unreadable
  folders.
- Created fresh perf-pass retry lanes:
  `vm audit retry local 20260517`
  (`64702258-59f6-4237-84a4-e83e8af305d3`) for the local-edit story and
  `vm audit retry mac 20260517`
  (`37ca2dc4-fcac-45a8-80a7-3eb2d262663f`) for isolated macOS GUI proof.
- Provider readiness was verified against the signed Cua Lume binary at
  `~/.local/share/lume/lume.app/Contents/MacOS/lume`; codesign entitlements
  included both `com.apple.security.virtualization` and
  `com.apple.vm.networking`.
- Fresh CLI start initially tried to pull `macos-tahoe-vanilla:latest`, which
  contradicted the VM tab/skill expectation that cached Sequoia IPSW creation is
  the default. The service now defaults missing provisioning mode to `create`
  and only pulls when `--mode pull-image` is explicit.
- The retry VM was created from the cached
  `UniversalMac_15.6.1_24G90_Restore.ipsw` at `1440x900`. The first ADE start
  then timed out because the generated VNC password began with `-` and ADE
  passed it as `--vnc-password -of6fFa1`; Lume parsed that as a missing option
  value. ADE now passes `--vnc-password=<value>` and captures early detached
  `lume run` exits so provider errors surface directly instead of becoming a
  generic two-minute timeout.
- Direct VNC screenshot proof succeeded through the product CLI and exited
  cleanly after the VNC teardown fix:
  `/Users/admin/Projects/perf pass/.ade/artifacts/macos-vms/37ca2dc4-fcac-45a8-80a7-3eb2d262663f/ade-perf-pass-vm-audit-retry-mac-20260517-37ca2dc4-1779047561855.png`
  and
  `/Users/admin/Projects/perf pass/.ade/artifacts/macos-vms/37ca2dc4-fcac-45a8-80a7-3eb2d262663f/ade-perf-pass-vm-audit-retry-mac-20260517-37ca2dc4-1779047585974.png`.
  The frame showed the macOS Sequoia Setup Assistant language screen at
  `1440x900`.
- `ade macos-vm click`, `ade macos-vm type`, and `ade macos-vm select` all
  returned `ok` against the retry VM through direct VNC. The earlier screenshot
  command leaked a VNC TCP handle in `FIN_WAIT_2`; `rfbDirectClient` now force
  closes the underlying socket after disconnect so one-shot CLI proof commands
  terminate.
- Lume reported `sshAvailable: false` for the fresh IPSW-created VM, and
  `lume ssh <vm>` returned `SSH is not available`. ADE now respects that field
  and no longer prints an SSH command in status unless the provider reports SSH
  availability.
- Lume's standalone `setup --mode preset --unattended sequoia --no-display`
  hung without output or debug artifacts both while the VM was running and from a
  stopped VM state. That leaves the raw IPSW create path verified for visible
  GUI control, screenshot, click, type, and selection, but not verified for
  unattended SSH-ready guest command execution.
- Re-running `ade macos-vm stop` after the retry also verified host cleanup:
  the retry VM stayed stopped and the matching Screen Sharing helper process was
  removed.
- Final cleanup deleted the retry VM through `ade macos-vm delete --force`;
  `lume ls` returned `No virtual machines found`, and ADE status showed no lane
  VMs.

## 2026-05-18 onboarding follow-up

- Codex Computer Use verified the fresh tied-lane VM story through macOS Screen
  Sharing: ADE created and started
  `ade-perf-pass-vm-audit-retry-mac-20260517-37ca2dc4`, Computer Use saw the
  Setup Assistant Language screen, and UI input advanced the guest through
  Language and Region into Transfer Data.
- The provider still reported `sshAvailable: false`, so the product cannot
  honestly call that state code-ready. ADE now models this separately as
  `guestReadiness.state = setup_required`, keeps `sshCommand` null, blocks the
  runtime-ready toggle, and shows first-boot setup onboarding in the VM console.
- Current Cua docs describe unattended setup as VNC/OCR automation that creates
  a `lume` user and enables SSH when successful, and also document `lume clone`
  for copying a configured VM. The product path should therefore be: guide the
  first raw IPSW VM through setup once, verify `guestReadiness.canRunCode`, then
  clone from a prepared base when lane-per-VM cloning is available in ADE.

## Route and readiness

| id | action | state | source | evidence |
| --- | --- | --- | --- | --- |
| vm.route.open | Open the dedicated VM tab at `/vm` | measured | `MacVmPage.tsx`, `App.tsx`, `TabNav.tsx` | UI reached `/vm`; manual step `vm.audit.unavailable-state` |
| vm.route.redirect | Preserve `/macos-vm` as a redirect to `/vm` | measured | `App.tsx` | Focused test coverage in `MacVmPage.test.tsx` |
| vm.host.support | Render Apple Virtualization host support | measured | `MacVmPage.tsx`, `macosVmService.ts` | UI showed host support OK on arm64 macOS |
| vm.provider.readiness | Render Lume provider status and install guidance | measured | `MacVmPage.tsx`, `macosVmService.ts` | UI showed unavailable before install, then `Lume 0.3.9` after `brew install lume` |
| vm.status.refresh | Refresh VM status from the tab | measured | `MacVmPage.tsx` | UI toast `VM status refreshed.`; manual step `vm.audit.refresh-unavailable` |
| vm.runtime.signin | Render runtime sign-in readiness | measured | `MacVmPage.tsx` | UI showed Runtime sign-in `Ready` |
| vm.single-lease.empty | Show no active VM lane reservation | measured | `MacVmPage.tsx`, `macosVmService.ts` | UI showed `Mac VM not created` |
| vm.single-lease.stale-cleanup | Surface stale reservation cleanup affordance | fixture-needed | `MacVmPage.tsx`, `macosVmRecovery.ts` | Requires seeded stale lease |
| vm.guest.setup-required | Detect fresh first-boot guests that are visible but not code-ready | measured | `macosVmService.ts`, `MacVmPage.tsx` | `sshAvailable: false` maps to `guestReadiness.state = setup_required`; VM tab shows first-boot setup and disables runtime-ready |
| vm.guest.code-ready | Mark guest code-ready only after SSH is available | measured | `macosVmService.ts` | Focused service coverage requires `sshAvailable: true` before `guestReadiness.canRunCode` |

## Lane creation

| id | action | state | source | evidence |
| --- | --- | --- | --- | --- |
| lanes.local.create | Create a normal local lane after perf-pass reset | measured | `CreateLaneDialog.tsx`, `laneService.ts` | Lane `vm audit local 20260516`; manual step `lanes.audit.create-local-lane` |
| lanes.vm.create.entry | Open Create lane dialog with VM runtime requested | measured | `LanesPage.tsx`, `CreateLaneDialog.tsx` | URL probe `/lanes?action=create&runtimePlacement=macos-vm` |
| lanes.vm.create.blocked | Keep VM lane creation disabled when Lume is unavailable | measured | `CreateLaneDialog.tsx` | `CREATE VM LANE` disabled; manual step `lanes.audit.create-vm-lane-blocked` |
| lanes.vm.branch-disabled | Disable custom branch for VM-backed lanes | measured | `CreateLaneDialog.tsx` | Dialog showed `Unavailable for VM-backed lanes` |
| lanes.vm.create.enabled | Create a VM-backed lane when host and provider are ready | measured | `CreateLaneDialog.tsx`, `laneService.ts` | UI created `vm e2e. lume20260516`, then `vm e2e. cua20260516` |
| lanes.vm.single-reservation | Enforce one active VM lane reservation | measured | `macosVmService.ts`, `CreateLaneDialog.tsx` | New VM Lane disabled while a VM lane was reserved; Remove Lane cleared the reservation |

## Lifecycle and display

| id | action | state | source | evidence |
| --- | --- | --- | --- | --- |
| vm.provision | Provision a VM for a fresh VM lane | measured | `macosVmService.ts` | Default `macos-tahoe-vanilla:latest` and `macos-tahoe-cua:latest` provisioned; documented `macos-sequoia-cua:15.3` failed under Lume `0.3.9`; IPSW create failed because the host requires a macOS software update |
| vm.start | Start the provisioned VM | measured | `macosVmService.ts` | Default image start timed out through ADE but manual Lume start worked; Tahoe CUA start succeeded through ADE with managed VNC credentials and with `openDisplay: true`, but never exposed a visible desktop; signed Lume + cached Sequoia 15.6.1 starts visibly with ADE embedded VNC plus a minimized Screen Sharing helper |
| vm.display.novnc | Open noVNC display session with managed credentials | measured | `MacVmPage.tsx`, `macosVmService.ts` | VM tab opened the embedded console for both running VMs |
| vm.display.frame | Read the latest VM display frame | measured | `MacVmPage.tsx`, `rfbDirectClient.ts` | Signed Lume + cached Sequoia 15.6.1 IPSW returned `imageState: visible` at `1440x900`; earlier Tahoe/prebuilt attempts remain documented as black-frame failures |
| vm.window.capture | Capture focused VM window fallback | measured | `macosVmService.ts` | macOS Screen Sharing attached to the same VNC endpoint; ADE now guards against duplicate Screen Sharing windows and minimizes the helper window for an already-connected VNC port |
| vm.screenshot | Capture screenshot proof for the VM lane | measured | `macosVmService.ts` | Direct VNC capture wrote a visible PNG artifact for `ade-perf-pass-vm-signed-lume-visible-1efa8906` |
| vm.focus | Focus the VM viewer/window | measured | `macosVmService.ts` | Direct VNC target reported `Headless VNC: <vm-name>` and frame `1280x720` |
| vm.click | Click VM display coordinates | measured | `MacVmPage.tsx`, `macosVmService.ts`, `rfbDirectClient.ts` | CDP/preload call clicked `320,240` after RFB framebuffer-size wait fix |
| vm.type | Type into the VM | measured | `MacVmPage.tsx`, `macosVmService.ts`, `rfbDirectClient.ts` | CDP/preload call returned `ok`; UI showed `Typed text into macOS VM through headless VNC.` |
| vm.shared-folder.roundtrip | Create guest work and see it in ADE | measured | `macosVmService.ts`, `files` IPC | Terminal inside the guest wrote `adevmroundtrip.txt` in `/Volumes/My Shared Files`; host lane filesystem and ADE files API both saw the file as untracked and readable |
| vm.stop | Stop a running VM | measured | `macosVmService.ts` | Both running VMs were stopped as part of ADE delete cleanup |
| vm.delete | Delete VM state and lease | measured | `macosVmService.ts` | Both Lume VMs were removed; stale Lume run processes had to be killed after `lume ls` was empty |

## CLI and agent surface

| id | action | state | source | evidence |
| --- | --- | --- | --- | --- |
| cli.macos-vm.help | Expose macOS VM help/guide commands | measured | `apps/ade-cli/src/cli.ts`, `ade-macos-vm` skill | Focused type/test coverage, skill docs |
| cli.macos-vm.status.headless | Read VM status without desktop UI | measured | `apps/ade-cli/src/cli.ts` | `ade --headless macos-vm status --text` showed Lume unavailable and no lane VMs |
| cli.macos-vm.status.socket | Read VM status through the dev runtime socket | measured | `apps/ade-cli/src/cli.ts`, `scripts/dev-desktop.mjs` | `ADE_RPC_SOCKET_PATH=/tmp/ade-runtime-dev.sock ade --socket macos-vm status --text` matched the UI blocker |
| cli.lanes.list.socket | Read lanes through the same dev runtime socket | measured | `apps/ade-cli/src/cli.ts` | Socket CLI listed `vm audit local 20260516` |
| cli.macos-vm.start | Start/create from CLI | measured | `apps/ade-cli/src/cli.ts`, `macosVmService.ts` | Fresh retry headless CLI created from cached Sequoia IPSW and started the VM through ADE after the default-create and VNC password argument fixes |
| cli.macos-vm.screenshot | Capture screenshot from CLI | measured | `apps/ade-cli/src/cli.ts`, `macosVmService.ts` | Fresh retry CLI capture wrote visible direct-VNC PNG artifacts and exited cleanly after the RFB socket teardown fix |
| cli.macos-vm.select-click-type | Select/click/type from CLI | measured | `apps/ade-cli/src/cli.ts`, `macosVmService.ts` | Select/click/type returned `ok` through direct VNC on the fresh retry VM; stale built CLI showed the original `0,0` click bug until rebuilt |
| cli.runtime-cleanup | Avoid stale ADE runtime endpoint processes during repeated dev Electron restarts | blocked | `apps/ade-cli/src/cli.ts`, dev launcher | Multiple stale `ade-cli serve` processes were left after Electron restarts and had to be killed before trusting endpoint/CLI probes |

## Focused validation

Passed during this audit:

```bash
npm --prefix apps/desktop run typecheck
npm --prefix apps/ade-cli run typecheck
npm --prefix apps/desktop run test -- src/main/services/macosVm/macosVmService.test.ts src/main/services/macosVm/macosVmRecovery.test.ts src/main/services/macosVm/rfbDirectClient.test.ts src/renderer/components/vm/MacVmPage.test.tsx src/preload/preload.test.ts src/main/services/lanes/laneLaunchContext.test.ts src/main/services/ipc/ipcTimeouts.test.ts src/main/services/adeActions/registry.test.ts
npm --prefix apps/desktop run test -- src/main/services/macosVm/macosVmService.test.ts src/main/services/macosVm/rfbDirectClient.test.ts
npm --prefix apps/desktop run test -- src/main/services/macosVm/macosVmService.test.ts src/main/services/macosVm/rfbDirectClient.test.ts src/main/services/lanes/laneService.test.ts
npm --prefix apps/ade-cli run test -- src/cli.test.ts src/adeRpcServer.test.ts
npm --prefix apps/ade-cli run typecheck
npm --prefix apps/ade-cli run build
npm --prefix apps/desktop run test -- src/main/services/macosVm/macosVmService.test.ts src/renderer/components/vm/MacVmPage.test.tsx
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run build
npm --prefix apps/desktop run lint
git diff --check
node scripts/perf-cdp-helper.mjs finalize
```

Result:

- Desktop focused tests: 8 files, 111 tests passed.
- Additional RFB/service regression tests: 2 files, 18 tests passed.
- Current macOS VM service/tab regression pass: 2 files, 23 tests passed.
- 2026-05-17 retry regression pass: 3 files, 81 tests passed.
- ADE CLI focused tests: 2 files, 288 tests passed.
- Typechecks, desktop/ADE CLI builds, whitespace check, and perf-run
  finalization passed.
- Desktop lint passed with the existing warning-only state (`0 errors`, `271`
  warnings).
