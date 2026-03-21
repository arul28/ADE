# Contributing to ADE

Pull requests are welcome from anyone. Only the maintainer (Arul) can merge or close PRs.

## Development Setup

```bash
cd apps/desktop
npm install
npm run dev
```

## Before Submitting

- Run `npm run typecheck` to check for type errors
- Run `npm test` to ensure all tests pass
- TypeScript strict mode is enabled
- Tests use Vitest

## Signed macOS releases

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

The tagged release workflow should be run from a tag that points at `main`. Push the release tag only after the intended `main` commit is in place.

## Code Style

- TypeScript with strict mode
- Follow existing patterns in the codebase
- Keep changes focused and minimal
