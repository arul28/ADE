# Desktop packaging: showing Daex without moving installs

The desktop app is renamed Daex, but every installed copy of ADE has to keep
working after it updates: same folders, same keychain items, same updater,
same shortcuts and `ade://` links. This page lists, per platform, what a
person sees, what now shows Daex, what keeps the old name and why, and what
is left for the owner to decide.

Read `README.md` in this folder first for the general rule (rename what a
person sees, freeze internal identifiers).

## The one fact that makes this safe

Electron names the app (`app.name`) from the **packaged** `package.json`:
`productName` if it has one, otherwise `name`. ADE's `productName` lives only
under `build`, which electron-builder strips from the packaged file, so the
running app is named **`ade-desktop`** on every platform (see the comments in
`apps/desktop/src/main/safeStorageKeyName.ts` and
`apps/desktop/scripts/run-electron-builder.mjs`).

Everything Electron derives from the app name comes from `ade-desktop`, not
from `ADE`:

| Derived from `app.name` (`ade-desktop`) | Path or name |
|---|---|
| userData | `~/Library/Application Support/ade-desktop`, `%APPDATA%\ade-desktop`, `~/.config/ade-desktop` |
| logs | `~/Library/Logs/ade-desktop`; inside userData on Windows and Linux |
| single-instance lock | `SingletonLock` in userData |
| safeStorage key | macOS Keychain item "ade-desktop Safe Storage"; Linux secret service app "ade-desktop"; Windows DPAPI key in userData `Local State` |
| updater cache | `~/Library/Caches/ade-desktop-updater`, `%LOCALAPPDATA%\ade-desktop-updater` (from `package.json` `name`) |

Stable packaged builds do not call `app.setPath("userData")`
(`resolveDesktopUserDataPath` returns null), and only an Alpha with nothing
sealed yet calls `app.setName` (`safeStorageKeyName.ts`). So the display
name, `build.productName` and the bundle's Info.plist can change without
touching any of these.

**Never add a top-level `productName` to `apps/desktop/package.json`.**
Electron would prefer it over `name`, and on the next launch every install
would get a new, empty userData folder, new logs, a new single-instance lock,
and a new keychain item that cannot open the secrets already sealed. If that
is ever needed, pin the old name first, the way Paradev does (below):
`app.setName("ade-desktop")` before anything reads a path or safeStorage.

## Frozen identities

These never change in this step. Each is read by an installed copy, the OS,
or the update feed.

| Identity | Value | Why it stays |
|---|---|---|
| appId / bundle ID | `com.ade.desktop` (Alpha `com.ade.desktop.alpha`) | macOS and Windows tie the install, notifications, keychain access and TCC grants to it. The NSIS uninstall key is a GUID made from it. |
| Windows AppUserModelId | `com.ade.desktop` (`ADE_WINDOWS_APP_USER_MODEL_ID`) | Taskbar grouping, pins, toasts and the jump list. |
| `build.productName` | `ADE` (Alpha `ADE Alpha`) | Sets the macOS bundle file name, executable and helper names, the Windows exe and install folder, `/opt/ADE` on Linux, and `installer.nsh` reads it to tell channels apart. |
| macOS bundle | `/Applications/ADE.app`, `Contents/MacOS/ADE`, `ADE Helper*.app`, Info.plist `CFBundleName` = `ADE` | Squirrel.Mac updates the bundle in place at its current path. Electron finds its helpers as `<CFBundleName> Helper.app`. Scripts, the Homebrew cask (`app "ADE.app"`) and `installedDesktopAppNames` look for `ADE.app`. |
| Windows install | `%LOCALAPPDATA%\Programs\ADE\ADE.exe` | The installer reuses the folder recorded under `HKCU\Software\<GUID>\InstallLocation`; taskbar pins and the `ade://` registration point at this exe. |
| Linux install | `/opt/ADE`, executable `ade-desktop`, deb package `ade-desktop`, `ade-desktop.desktop`, WM class `ade-desktop` | The deb installs to `/opt/<productName>`; the in-app updater relaunches from there; the desktop entry matches the window by WM class. |
| URL scheme | `ade://` | Accepted forever. `daex://` is now registered beside it (`build.protocols` lists both, `registerAdeProtocolHandler` claims both) and every parser accepts both. New links are made as `daex://` (`BRAND.LINK_SCHEME_FOR_NEW_LINKS`); the launch minimum version keeps releases that register only `ade://` from running. |
| Update feed | GitHub `arul28/ADE`; assets `ADE-<version>-<arch>.dmg/.zip`, `ADE-<version>-win-x64.exe`, `ADE-<version>-linux-<arch>.AppImage`; `latest*.yml` | Released builds look for these exact names. The Homebrew cask and `scripts/release-tools/verify-desktop-draft.sh` use them too. |
| Windows file type ProgID | `com.ade.desktop.files` | The registry key for file associations. |
| `ADE_DESKTOP_APP_NAME` | `ADE` / `ADE Alpha` | Names the installed app on disk for native helper lookups and the CLI wrappers. Not a display name. |

## macOS

**What a person saw:** "ADE" in the menu bar, Dock, Finder, Launchpad,
Spotlight, About panel, notifications, permission prompts ("ADE would like to
use the microphone"), the DMG volume.

**What changed (shipped in this branch):**

- `apps/desktop/scripts/after-pack-runtime-fixes.cjs` writes
  `Contents/Resources/<locale>.lproj/InfoPlist.strings` into every locale
  folder with `CFBundleName` and `CFBundleDisplayName` = `Daex` (`Daex Alpha`
  for an `ADE Alpha` product). `build.mac.extendInfo.LSHasLocalizedDisplayName`
  is `true`.
- Permission prompt text (`NS*UsageDescription`), the URL type name
  (`CFBundleURLName`, "Daex link") and the document type names
  ("Daex files and folders", "Daex files") in `apps/desktop/package.json`.
- `apps/desktop/src/main/main.ts`: the application menu ("About Daex",
  "Hide Daex", "Quit Daex"), `app.setAboutPanelOptions({ applicationName })`,
  window titles, dialogs and notifications.
- `apps/desktop/scripts/create-mac-dmg.mjs`: the DMG volume is named "Daex".
- The macOS 26 icon (see "macOS 26 app icon" below): `Assets.car` and
  `CFBundleIconName` from `build/icon*.icon`, beside the unchanged `icon.icns`.
- The brain's executable is `Contents/MacOS/Daex Brain` (was `ADE Brain`), the
  name macOS shows in "Background Items Added" and Login Items (see "The brain
  copy's name" below).

**What stays:** the file `ADE.app`, `Contents/MacOS/ADE`, the helper bundles,
the Info.plist `CFBundleName`/`CFBundleDisplayName` (`ADE`), the bundle ID,
the artifact names, the launchd labels and plist file names
(`com.ade.runtime*`, `com.ade.watchdog*`).

**How it works:** macOS shows a name other than the Info.plist one only
through `InfoPlist.strings`. The menu bar, About panel and notifications use
the localized `CFBundleName`; Finder, the Dock and Launchpad use the localized
`CFBundleDisplayName`, and only when the Info.plist `CFBundleDisplayName`
equals the bundle's file name (`ADE` = `ADE.app`) and
`LSHasLocalizedDisplayName` is set. Electron finds its helper apps with
`GetApplicationName()`, which reads `[bundle infoDictionary]` (the raw
Info.plist, never `InfoPlist.strings`;
`shell/common/application_info_mac.mm`), so the localized name cannot break
launch. The strings are written in afterPack, before electron-builder signs,
so they are sealed into the signature like any other resource. Both
architecture builds get identical files, which `@electron/universal`
requires.

**Risks:**

- A person who renamed `ADE.app` by hand sees "ADE" in Finder (the file name
  no longer matches `CFBundleDisplayName`). The menu bar still shows Daex.
- `open -a Daex` and AppleScript `application "Daex"` may not find the app;
  `open -a ADE` keeps working. Nothing in ADE uses either.
- Copy that tells people which app to switch on in System Settings > Privacy
  (`macDesktopService.ts` `responsibleAppName`, from `ADE_DESKTOP_APP_NAME`)
  still says ADE while System Settings will list "Daex". Outside this change.

### macOS 26 app icon

macOS 26 draws an app whose only icon is an `.icns` as a "legacy" icon: the
art shrunk inside a grey rounded frame (Dock, Finder, About). A full-size icon
comes from an asset catalog: `Contents/Resources/Assets.car`, named by
`CFBundleIconName`.

- `apps/desktop/build/icon.icon`, `icon.beta.icon`, `icon.alpha.icon` are Icon
  Composer packages with two layers: `background.png` (the full-bleed
  `assets/brand/daex/icon-ios-*.png` art with the glyph painted out) and
  `glyph.png` (white, alpha from `glyph-mask.png`, with Liquid Glass on).
- `apps/desktop/scripts/mac-icon-composer.cjs` (afterPack, macOS) compiles the
  `.icon` beside the configured `.icns` (`build/icon.icns` -> `build/icon.icon`,
  `build/icon.beta.icns` -> `build/icon.beta.icon`, ...) with `actool` into
  `Assets.car` and sets `CFBundleIconName` = `AppIcon`. So every channel follows
  its `.icns` with no extra wiring: `build.mac.icon`, Beta's
  `scripts/beta/apply-build-track.mjs` and `scripts/package-channel.mjs`.
- `CFBundleIconFile` stays `icon.icns`, the committed art, so macOS 15 and older
  show exactly what they did. The catalog is compiled for macOS 26 only
  (`--minimum-deployment-target 26.0`), as electron-builder's own `.icon`
  support does.
- electron-builder 26.15.3 accepts a `.icon` as `mac.icon`, but it then replaces
  `icon.icns` with actool's rendering and fails any build whose selected Xcode
  is older than 26. The hook keeps the `.icns` and finds an Xcode 26 or newer
  by itself (the selected one, else the newest `/Applications/Xcode*.app`, via
  `DEVELOPER_DIR`), so release runners whose default Xcode is older still work.
- `ADE_MAC_ICON_COMPOSER`: unset, the icon is required when the build signs
  (`CSC_LINK`/`CSC_NAME`, every release) and a warning otherwise (a local
  `dist:mac:dir` without Xcode 26); `required` or `off` force either.
- Written in afterPack, before signing, so it is sealed like any resource. In a
  universal build electron-builder copies the x64 `Assets.car` over the arm64
  one before merging, so both are identical.

### The brain copy's name

The brain service, its watchdog and its PTY host run a copy of the app's
executable (`brainExecutable.ts`, mode `brain-copy`). macOS names the
background item after that file. It is now `Daex Brain` (`Daex Alpha Brain`
for `ADE Alpha`); it was `ADE Brain`.

Why this is safe for existing installs:

- Every install of the service renders the launch agent and rewrites
  `~/Library/LaunchAgents/com.ade.runtime*.plist` (and the watchdog's) whenever
  its text differs (`installLaunchdService`, `installLaunchdWatchdogAgent`).
  The desktop installs on every launch (`installServiceBestEffort`), the CLI on
  `ade brain start`, a repair, and every update path (Squirrel update, CLI
  update, `ade brain update`). An old plist names `ADE Brain`, so the first
  install by a new build rewrites it to `Daex Brain` and restarts the brain.
  Labels and plist file names do not change, so nothing is left behind.
- The bundle also carries `Contents/MacOS/ADE Brain`, a second signed copy
  (34 KB), so an old plist still starts after an update that replaced the
  bundle without installing the service (a Homebrew upgrade or a drag-and-drop
  install, then a restart before the app opens).
- Readers accept both names: `electronMacExecutables` maps `Daex Brain` and
  `ADE Brain` to the same app (so `isSameElectronRuntime`, the build hash and
  `hostAppPath` agree), and the sync-host scan (`syncHostSingleton.ts`) matches
  both process names, including lsof's cut-off 9-character form.
- No SMAppService or `SMLoginItemSetEnabled` registration exists; the brain is
  a plain launch agent with `AssociatedBundleIdentifiers` = the app's bundle ID.

Removing the legacy copy later: once no supported release writes `ADE Brain`
and the launch minimum version has been in force for a while, drop the second
name from `brainCopyPaths` (`scripts/mac-brain-copy.cjs`); keep the readers.

Checked on macOS 26.6.2 (NoMac, 2026-11-27, `dist:mac:dir`, ad-hoc sealed the
way `package-channel.mjs` seals): the app installed both launch agents with
`Daex Brain`, the notice read "Daex Brain can run in the background", and
`codesign --verify --deep --strict` passed with both copies signed as
`com.ade.desktop`. Then both plists were rewritten to `ADE Brain` and
reloaded, as an older build leaves them: the brain started as `ADE Brain`
(the legacy copy). Reopening the app rewrote both plists to `Daex Brain`, the
brain ran as `Daex Brain`, and `sfltool dumpbtm` and Login Items listed only
`Daex Brain`.

## Windows

**What a person saw:** window titles and dialogs; the Start menu shortcut
"ADE", the installed apps entry "ADE", the taskbar group and toast
notifications (both named from the Start menu shortcut that carries the
AUMID), Task Manager ("ADE", the exe's FileDescription), the installer
("ADE Setup" and its built-in text), the "Updating ADE" window.

**What changed (shipped in this branch):**

- Window titles, dialogs, notifications and the jump-list task ("Install a
  downloaded Daex update") in `main.ts`; the file type description written to
  the ProgID (`--config.fileAssociations.description`, "Daex files", in
  `run-electron-builder.mjs`).
- Decision 1: the Start menu shortcut and the installed apps entry
  ("Apps & features" / "Installed apps") say **Daex**, **Daex Beta** or
  **Daex Alpha**, for new installs and for every existing install on its next
  update. `run-electron-builder.mjs` passes `--config.nsis.shortcutName` and
  `--config.nsis.uninstallDisplayName` from `displayName` in
  `windows-package-identity.mjs`. The taskbar group and toasts take their name
  from that shortcut, so they say Daex too.
- The custom installer and uninstaller text in `build/installer.nsh`
  (`DetailPrint` lines and message boxes, "Daex could not stop its background
  service…") says Daex. Every `PRODUCT_NAME` comparison and path is unchanged.
- `windows-installed-product-smoke.ps1` (the release gate) looks for the
  installed apps entry by its Daex name and checks that the Daex Start menu
  shortcut exists.

**How decision 1 works** (electron-builder 26.15.3, `app-builder-lib`):

- `shortcutName` only sets the NSIS define `SHORTCUT_NAME`
  (`CommonWindowsInstallerConfiguration.js`, `NsisTarget.js`). It names
  `$SMPROGRAMS\<name>.lnk` (and the desktop link, which ADE does not create)
  and is stored as `ShortcutName` in `HKCU\Software\<GUID>`. Nothing else
  reads it.
- `uninstallDisplayName` only sets `UNINSTALL_DISPLAY_NAME`, written as
  `DisplayName` under the Uninstall key. The key itself is a GUID made from
  `appId`, so the entry is the same one, renamed; Windows never shows two.
- On an update, `setLinkVars` (`common.nsh`) reads the old name from
  `ShortcutName` ("ADE"), the old uninstaller runs with `--keep-shortcuts`
  (the install key has `KeepShortcuts=true` and the exe exists), so it leaves
  `ADE.lnk` alone, and `addStartMenuLink` (`include/installer.nsh`) renames
  `ADE.lnk` to `Daex.lnk` and stamps the AUMID `com.ade.desktop` on it again.
  A person who deleted the shortcut does not get one back, as before.
- That `Rename` fails if `Daex.lnk` already exists, which would leave both.
  `customInstall` then deletes the old one, only when it opens this install's
  exe (`adeRemoveStaleStartMenuLink`; one PowerShell run, only in that case).
- Downgrading to an older release reverses it: the old installer reads
  `ShortcutName` "Daex" and renames the shortcut back to "ADE".
- Uninstall reads `ShortcutName`, so it removes `Daex.lnk`.

**What stays, and why:**

- `productName` `ADE` / `ADE Beta` / `ADE Alpha` (`windows-package-identity.mjs`).
  It names `ADE.exe`, the install folder, `Uninstall ADE.exe`, and
  `PRODUCT_NAME`, which `build/installer.nsh` compares to `"ADE Alpha"` and
  `"ADE Beta"` to pick the channel for every install, update and uninstall
  step.
- The exe's version info (FileDescription, ProductName), so Task Manager and
  the "Open with" list say "ADE". electron-builder writes it from
  `productName` with rcedit **after** afterPack runs, so a hook cannot change
  it without re-signing.
- The installer's title ("ADE Setup") and electron-builder's built-in
  messages, which come from `PRODUCT_NAME`; the file association verb
  "Open with ADE", which electron-builder builds from `productName` with no
  option.
- Taskbar pins. A pin is a copy of the shortcut in `User Pinned\TaskBar`
  that points at `ADE.exe` with the AUMID; neither moves, so it keeps working.
  Its own file keeps the name "ADE" until the person pins again.
- The "Updating ADE" window takes its name from
  `appPackageChannelDisplayName` (`src/shared/packageChannel.ts`), which is
  display only and can move to `BRAND` with the rest of `src/shared`.

## Linux

**What a person saw:** "ADE" as the launcher name (desktop entry `Name`),
"ADE" as the deb maintainer.

**What changed (shipped in this branch):** `run-linux-electron-builder.mjs`
passes `--config.linux.desktop.entry.Name=Daex` (`Daex Alpha` for Alpha);
`build.linux.maintainer` is "Daex".

**What stays:** `productName` `ADE` (so `/opt/ADE`), the executable
`ade-desktop`, the deb package name `ade-desktop`, the desktop file name
`ade-desktop.desktop` and `StartupWMClass=ade-desktop`, the AppImage file
name, the secret service entry `ade-desktop`.

**How it works:** electron-builder merges `linux.desktop.entry` over the
entry it computes, so only `Name` changes; `Exec`, `Icon`, `StartupWMClass`
and `MimeType` (`x-scheme-handler/ade`) are computed as before. The schema
check and the CLI parsing of the nested flag were checked with the installed
electron-builder 26.15.3.

**Risk:** low. Launchers re-read the desktop entry on install.

## What Paradev did (Superset -> Paradev)

From `ParadevAI/Paradev` `apps/desktop/electron-builder.ts`,
`scripts/builder-product-name.ts`, `scripts/localize-display-name.ts` and
`src/main/lib/legacy-app-name/`:

- **macOS:** `productName` became "Paradev", so new builds are `Paradev.app`.
  They pinned `CFBundleExecutable` and the Info.plist `CFBundleDisplayName` to
  the legacy "Superset" ("Squirrel.Mac renames the installed bundle when the
  executable name equals the bundle file name … the executable keeps this name
  so existing Superset.app installs stay put"). They set `CFBundleName` to the
  product name because Electron finds `<CFBundleName> Helper.app`. An
  afterPack hook writes `InfoPlist.strings` (`CFBundleName`,
  `CFBundleDisplayName`) into every `.lproj` and they set
  `LSHasLocalizedDisplayName`, so `Superset.app` shows "Paradev".
- **Linux:** `builderProductName` keeps `productName` "Superset" for Linux
  builds only (and refuses to build Linux in the same run as other
  platforms), because the deb installs to `/opt/<productName>` and released
  builds update from there. The desktop entry `Name` is the display name;
  `executableName` and `StartupWMClass` are `superset`; the deb package stays
  `superset`.
- **Windows:** `productName` "Paradev"; NSIS keeps a recorded install folder
  on update.
- **userData:** their app name did follow `productName`, so at boot
  `pinLegacyAppName()` calls `app.setName("Superset")` when
  `<appData>/Superset` exists, before anything reads userData, logs or
  safeStorage.

ADE needs less of this: its `app.name` is already `ade-desktop`, independent
of `productName`, so no pin is needed. ADE keeps `productName` "ADE" on every
platform for now and takes only Paradev's display-name mechanism (the
`InfoPlist.strings` and the Linux desktop entry name).

## Owner decisions

1. **Windows Start menu shortcut, taskbar and toast name, Apps list entry.**
   Done: the owner chose Daex for everyone, existing installs included. See
   "Windows" above for what changed and how, and "Windows update test" below
   for the result. `productName` stays "ADE"; Task Manager keeps "ADE" until
   it changes (decision 3).
2. **macOS `.app` file name and executable.** Recommendation: keep `ADE.app`.
   The display change already shows Daex everywhere a person looks. Renaming
   the bundle for new installs (Paradev's route) means `productName` "Daex",
   `CFBundleExecutable` pinned to "ADE", and every place that looks for
   `ADE.app` learning both names: `create-mac-dmg.mjs`,
   `notarize-mac-dmg.mjs`, `resign-mac-universal-app.mjs`,
   `prepare-universal-mac-inputs.mjs`, `validate-mac-artifacts.mjs`,
   `old-database-launch-check.mjs`, the `dist:mac:*` scripts in
   `package.json`, `scripts/package-channel.mjs`, the Homebrew cask,
   `installedDesktopAppNames` (`nativeHelperPaths.ts`),
   `ade-cli-macos-wrapper.sh`, `ADE_DESKTOP_APP_NAME`. Existing installs stay
   `ADE.app` either way, so two names would live side by side forever.
3. **Windows `productName`, exe name and install folder.** Recommendation:
   keep `ADE`, like Paradev kept Linux. Changing it moves new installs to
   `Programs\Daex\Daex.exe`, breaks the `PRODUCT_NAME` channel checks in
   `installer.nsh`, the CLI wrapper's `ADE.exe` lookup
   (`ade-cli-windows-wrapper.cmd`) and the update scripts, for one name in
   Task Manager.
4. **Linux `/opt/ADE` and `productName`.** Recommendation: keep, as Paradev
   did.
5. **Artifact and feed names** (`ADE-<version>-…`, `arul28/ADE`).
   Recommendation: keep until a release publishes both names and released
   builds have moved to a feed that knows the new ones.
6. **`daex://`.** Done: `build.protocols` registers `ade` and `daex`, the
   protocol handler claims both, and `src/shared/deeplinks.ts` parses both.
   New links are `daex://` (`BRAND.LINK_SCHEME_FOR_NEW_LINKS`); set the
   launch minimum version first (README, "Launch steps"). The Windows
   uninstaller removes both registrations when they point at the install.

## Windows update test

Run on 2026-11-27 in Windows Sandbox on Windows 11 (nothing ran on the host).
The old build is the released Stable `ADE-1.2.137-win-x64.exe` from
`arul28/ADE`. The new build is this branch's NSIS config and `installer.nsh`
wrapped around the 1.2.137 app files: `7z` pulls `$PLUGINSDIR\app-64.7z` out
of the released installer and unpacks it, then
`ADE_DESKTOP_VERSION=1.2.138 node scripts/run-electron-builder.mjs --win --x64
--publish never --prepackaged <app dir> --config.directories.output=<dir>`
builds an unsigned `ADE-1.2.138-win-x64.exe`. A `.wsb` file maps both
installers and a script read-only, plus one writable output folder, with
networking off; the script records the state after each step.

| Step | Start menu (`%APPDATA%\…\Programs`) | Installed apps `DisplayName` | `ShortcutName` | Install folder |
|---|---|---|---|---|
| Install 1.2.137 (`/S`) | `ADE.lnk` -> `…\Programs\ADE\ADE.exe`, AUMID `com.ade.desktop` | `ADE` (1.2.137) | `ADE` | `…\Programs\ADE` |
| Update (`--updated /S`, as the updater runs it) | `Daex.lnk` -> same exe, AUMID `com.ade.desktop`; no `ADE.lnk` | `Daex` (1.2.138), same uninstall key | `Daex` | `…\Programs\ADE`, `ADE.exe` |
| Downgrade to 1.2.137 (`/S`) | `ADE.lnk` (renamed back) | `ADE` | `ADE` | unchanged |
| Add a stray `Daex.lnk`, then install 1.2.138 (`/S`) | `Daex.lnk` only (the old one removed by `customInstall`) | `Daex` | `Daex` | unchanged |
| Uninstall (`QuietUninstallString`) | no ADE or Daex shortcut | no entry | no key | removed |

All installers exited 0. A copy of the original `ADE.lnk` (what a taskbar
pin holds) still pointed at an existing `ADE.exe` after the update.

Not covered: the taskbar and toast names on a real desktop (no one clicked
in the sandbox; they follow the shortcut, per Windows), Beta and Alpha
builds (same code path; their names come from `displayName`), and a signed
CI build. Before release, `windows-installed-product-smoke.ps1` checks the
Daex entry and shortcut on the CI runner.

## Mac test

Run on 2026-11-27 on a NoMac Mac (macOS 26.6.2, Xcode 27.2, Apple silicon):
`ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY=1 npm run dist:mac:dir`, the app
ad-hoc sealed and copied to `/Applications/ADE.app`.

- The menu bar, About panel and Dock show Daex; the Dock and About icon are
  full size with no grey frame (the `.icon` above). `Info.plist` has
  `CFBundleIconFile` = `icon.icns` (the committed file) and
  `CFBundleIconName` = `AppIcon`; `Contents/Resources` has both.
- `build/icon.beta.icon` and `build/icon.alpha.icon` compile with actool and
  render with `ictool`; no Beta or Alpha app was built.
- `CFBundleExecutable` is still `ADE`; all 55 `.lproj` folders got
  `InfoPlist.strings`; the ad-hoc sealed app passes
  `codesign --verify --deep --strict`.
- The brain-copy rename (above).

## Not verified

No Linux build ran here, and no signed or notarized Mac build.
Checked instead: electron-builder 26.15.3 source
(Info.plist, NSIS, desktop entry, packaged `package.json`), Electron's helper
lookup source, the config schema with the new keys, and the CLI parsing of
the Linux flag.

Before release, on a Mac (`npm run dist:mac:dir`), the items the Mac test
above did not cover:

- Finder shows Daex; a signed and notarized build passes
  `codesign --verify --deep --strict` and Gatekeeper with both brain copies.
- It uses `~/Library/Application Support/ade-desktop` and reads its saved
  secrets with no keychain prompt.
- Updating a released build through the updater leaves it at
  `/Applications/ADE.app`.

On Linux: `dpkg -c` lists `/opt/ADE/…`;
`/usr/share/applications/ade-desktop.desktop` has `Name=Daex` and
`StartupWMClass=ade-desktop`; the running window groups under that launcher.

On Windows: the installed exe and folder are unchanged
(`windows-installed-product-smoke.ps1`); window titles read "… - Daex"; the
Start menu entry, taskbar hover and a toast say Daex after a real update.
