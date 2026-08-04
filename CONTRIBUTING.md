# Contributing to ADE

Pull requests are welcome from anyone. Only the maintainer (Arul) can merge or close PRs.

## Development Setup

Install dependencies for each app from the repo root:

```bash
npm run setup
```

Start the normal desktop development flow from the repo root:

```bash
npm run dev
```

This builds the ADE CLI, refreshes the shared dev runtime when needed, launches
the Electron desktop app, and points desktop at that runtime. For renderer-only
UI work, see [apps/desktop/README.md](apps/desktop/README.md).

`npm run dev` also works from a lane checkout under `.ade/worktrees/<lane>`. To
run a lane build **in isolation** — its own runtime + bridge sockets, without
restarting your installed app's runtime — follow
[Run a specific lane worktree](README.md#run-a-specific-lane-worktree) in the root
README. Key rule: never aim `dev:desktop --socket` at a runtime you do not want
`--auto` to shut down; use a fresh per-lane `/tmp/ade-runtime-<lane>.sock`.

On Windows, `npm run dev` uses a per-user named pipe instead of a Unix socket
path, and ADE runs on Windows 10/11 x64 only. Platform behaviour, the background
brain contract, and the current gaps are documented in
[docs/development/windows-support.md](docs/development/windows-support.md).

## Before Submitting

- Run the smallest relevant checks for your change first
- Desktop: `npm --prefix apps/desktop run typecheck`, targeted Vitest files, and `npm --prefix apps/desktop run lint` when touching renderer or main-process code
- ADE CLI: `npm --prefix apps/ade-cli run typecheck` and `npm --prefix apps/ade-cli run test` when touching CLI/runtime code
- Docs: `node scripts/validate-docs.mjs` (fetch tags first if your clone is shallow)
- TypeScript strict mode is enabled
- Tests use Vitest

## Signed releases

### macOS

For ADE's current release path, the correct Apple objects are:

- `Developer ID Application` certificate for signing the `.app`
- App Store Connect `Team Key` for notarization

You do not need these for the current ADE flow:

- `Developer ID Installer` certificate, because ADE ships `dmg` + `zip`, not `pkg`
- A provisioning profile, unless the app later adds Apple advanced capabilities that require a Developer ID provisioning profile

The tagged macOS release workflow expects these GitHub Actions secrets:

- `CSC_LINK` — Developer ID Application certificate (`.p12`), typically base64-encoded
- `CSC_KEY_PASSWORD` — password for the Developer ID Application certificate
- `APPLE_API_KEY_P8` — raw contents of the App Store Connect Team API key (`AuthKey_*.p8`)
- `APPLE_API_KEY_ID` — App Store Connect key ID
- `APPLE_API_ISSUER` — App Store Connect issuer ID

The release workflow builds ADE in three stages:

1. `arm64` app bundle on `macos-latest`
2. `x64` app bundle on `macos-15-intel`
3. universal app merge, then signing, notarization, `dmg`/`zip` packaging, and GitHub release publish from the merged app

Current Apple setup flow:

1. On a Mac, create a CSR in Keychain Access using `Certificate Assistant > Request a Certificate from a Certificate Authority`, and save it to disk.
2. In Apple Developer > Certificates, Identifiers & Profiles > Certificates, click `+`.
3. Under `Software`, choose `Developer ID`, then choose `Developer ID Application`.
4. Upload the CSR, download the `.cer`, and double-click it so it appears in Keychain Access under `login > My Certificates`.
5. Export that certificate from Keychain Access as a `.p12` file with a password. This is the certificate material used by `CSC_LINK`.
6. In App Store Connect > Users and Access > Integrations > Team Keys, generate a Team API key and download the `.p8` file. Note the key ID and issuer ID.

To test a signed macOS build locally, export the matching environment variables expected by `electron-builder` and run:

```bash
cd apps/desktop
export CSC_LINK=/absolute/path/to/DeveloperIDApplication.p12
export CSC_KEY_PASSWORD=...
export APPLE_API_KEY=/absolute/path/to/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
npm run dist:mac:signed
```

To test the unsigned intermediate app bundle that the CI workflow produces per architecture, run:

```bash
cd apps/desktop
npm run dist:mac:dir -- --arm64
```

### Windows

Windows release publication is gated on the repository variable
`ADE_WINDOWS_PUBLIC_RELEASE_ENABLED`. With it unset, the Windows jobs skip
cleanly and the tagged release ships macOS assets only. The signed Windows path
requires a pinned Authenticode identity, the same signer for the installer and
`ADE.exe`, and a trusted RFC3161 timestamp. Pull-request preview builds are
unsigned and are for internal testing only.

The tagged release workflow should be run from a tag that points at `main`. Push the release tag only after the intended `main` commit is in place.

## Code Style

- TypeScript with strict mode
- Follow existing patterns in the codebase
- Keep changes focused and minimal
