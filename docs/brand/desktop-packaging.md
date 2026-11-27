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
| URL scheme | `ade://` | Accepted forever. `daex://` is added in a later step (README, Sunset identifiers). |
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

**What stays:** the file `ADE.app`, `Contents/MacOS/ADE`, the helper bundles,
the Info.plist `CFBundleName`/`CFBundleDisplayName` (`ADE`), the bundle ID,
the artifact names.

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

- Not built or run on a Mac in this branch (see "Not verified").
- A person who renamed `ADE.app` by hand sees "ADE" in Finder (the file name
  no longer matches `CFBundleDisplayName`). The menu bar still shows Daex.
- `open -a Daex` and AppleScript `application "Daex"` may not find the app;
  `open -a ADE` keeps working. Nothing in ADE uses either.
- Copy that tells people which app to switch on in System Settings > Privacy
  (`macDesktopService.ts` `responsibleAppName`, from `ADE_DESKTOP_APP_NAME`)
  still says ADE while System Settings will list "Daex". Outside this change.

## Windows

**What a person sees today:** window titles and dialogs (now Daex); the
Start menu shortcut "ADE", the Apps list entry "ADE", the taskbar group and
toast notifications (both named from the Start menu shortcut that carries the
AUMID), Task Manager ("ADE", the exe's FileDescription), the installer
("ADE Setup" and its built-in text), the "Updating ADE" window.

**What changed (shipped in this branch):** window titles, dialogs,
notifications and the jump-list task ("Install a downloaded Daex update") in
`main.ts`; the file type description written to the ProgID
(`--config.fileAssociations.description`, "Daex files", in
`run-electron-builder.mjs`).

**What stays, and why:**

- `productName` `ADE` / `ADE Beta` / `ADE Alpha` (`windows-package-identity.mjs`).
  It names `ADE.exe`, the install folder, and `PRODUCT_NAME`, which
  `build/installer.nsh` compares to `"ADE Alpha"` and `"ADE Beta"` to pick the
  channel for every install, update and uninstall step.
- The exe's version info (FileDescription, ProductName). electron-builder
  writes it from `productName` with rcedit **after** afterPack runs, so a hook
  cannot change it without re-signing.
- Start menu shortcut name and Apps list name: owner decision 1.
- The custom installer text in `build/installer.nsh` ("ADE could not
  configure its terminal command…"). The installer's own title and built-in
  messages come from `PRODUCT_NAME` and stay "ADE", so the custom lines stay
  too and change together with decision 1. The strings can change at any
  time; the `PRODUCT_NAME` comparisons cannot.
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
   Recommendation: do it in a follow-up with a Windows update test.
   Set `nsis.shortcutName` to the Daex name per channel (`Daex`, `Daex Beta`,
   `Daex Alpha`) and `uninstallDisplayName` to the same, from
   `run-electron-builder.mjs`, and keep `productName` "ADE". electron-builder's
   NSIS template already handles an existing install: it reads the old
   shortcut name from `HKCU\Software\<GUID>\ShortcutName`, renames
   `ADE.lnk` to `Daex.lnk` and stamps the AUMID on it again
   (`templates/nsis/include/installer.nsh`, `common.nsh`), and the install
   folder stays the recorded one. Taskbar pins point at `ADE.exe`, which does
   not move. Needed with it: update the `uninstallDisplayName` check in
   `validate-win-artifacts.mjs`, switch the custom text in
   `build/installer.nsh` to Daex, and test a real update from the released
   build (shortcut renamed, pin works, toasts say Daex, one Apps entry).
   Task Manager keeps "ADE" until `productName` changes.
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
6. **`daex://`.** Planned in the README (Sunset identifiers): add the scheme
   to `build.protocols` and parse it in `src/shared/deeplinks.ts` in one
   change.

## Not verified

Built and run nothing: electron-builder for macOS needs a Mac, and no
installer was built here. Checked instead: electron-builder 26.15.3 source
(Info.plist, NSIS, desktop entry, packaged `package.json`), Electron's helper
lookup source, the config schema with the new keys, and the CLI parsing of
the Linux flag.

Before release, on a Mac (`npm run dist:mac:dir`):

- `Contents/Info.plist` still has `CFBundleName` = `ADE`,
  `CFBundleExecutable` = `ADE`; every `Contents/Resources/*.lproj` has
  `InfoPlist.strings`; `codesign --verify --deep --strict` passes.
- The app launches; the menu bar, About panel, Finder and Dock show Daex.
- It uses `~/Library/Application Support/ade-desktop` and reads its saved
  secrets with no keychain prompt.
- Updating a released build through the updater leaves it at
  `/Applications/ADE.app`.

On Linux: `dpkg -c` lists `/opt/ADE/…`;
`/usr/share/applications/ade-desktop.desktop` has `Name=Daex` and
`StartupWMClass=ade-desktop`; the running window groups under that launcher.

On Windows: the installed exe and folder are unchanged
(`windows-installed-product-smoke.ps1`); window titles read "… - Daex".
