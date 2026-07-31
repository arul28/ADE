# Maintainer guide: Publish signed Windows builds

Use this guide after the Windows release changes have been merged into `main`.

ADE already publishes macOS and standalone Mac/Linux files through GitHub Releases. The Windows release uses that same pipeline.

After setup, a normal release is:

1. A maintainer tags an approved commit.
2. GitHub Actions builds, signs, and checks every platform.
3. GitHub Actions creates one unpublished GitHub Release.
4. A maintainer checks it and makes it public.

Nobody builds or uploads the Windows installer by hand.

Each Windows release adds one file for people to download: `ADE-<VERSION>-win-x64.exe`. It also includes two small files used by ADE's automatic updater: the `.blockmap` helps download only what changed, and `latest.yml` identifies and verifies the current installer.

## Start here

Complete these actions in order:

1. Configure the Windows signing credentials in GitHub Actions.
2. Enable signed test builds while keeping Windows publication off.
3. Build a signed test version in GitHub Actions.
4. Test the installer on clean Windows 10 and Windows 11 computers.
5. Enable Windows in the production release workflow.
6. Tag the approved commit. GitHub Actions builds every platform and creates one unpublished release.
7. Check the release, make it public, and enable the Windows website link.

The sections below provide the commands and pass conditions.

## One-time setup

Perform these actions once before the first public Windows release.

### 1. Configure signing

The current workflow supports a password-protected PFX/P12 signing certificate. If you choose a signing service that does not provide one, such as Microsoft Artifact Signing, adapt the workflow to that service before continuing.

Add these GitHub Actions secrets:

- `WINDOWS_CSC_LINK`: the PFX/P12 file encoded as Base64 text, or a private HTTPS URL that returns it.
- `WINDOWS_CSC_KEY_PASSWORD`: the certificate password.
- `WINDOWS_SIGNING_EXPECTED_SUBJECT`: the certificate's complete Subject value exactly as Windows reports it, such as `CN=Publisher, O=Company, C=US`.
- `WINDOWS_SIGNING_EXPECTED_THUMBPRINT`: the approved certificate fingerprint.

Set the complete Subject value, the fingerprint, or both. If both are set, both must match.

```bash
gh secret set WINDOWS_CSC_LINK --repo arul28/ADE
gh secret set WINDOWS_CSC_KEY_PASSWORD --repo arul28/ADE
gh secret set WINDOWS_SIGNING_EXPECTED_SUBJECT --repo arul28/ADE
gh secret set WINDOWS_SIGNING_EXPECTED_THUMBPRINT --repo arul28/ADE
```

Each command asks for the secret without printing it in the command.

Enable signed test builds, but keep Windows out of public releases:

```bash
gh variable set ADE_WINDOWS_SIGNED_BUILD_ENABLED \
  --repo arul28/ADE --body 1
gh variable set ADE_WINDOWS_PUBLIC_RELEASE_ENABLED \
  --repo arul28/ADE --body 0
```

### 2. Run the signed build in GitHub Actions

Use the version and commit intended for the first Windows release:

```bash
VERSION="<VERSION>"
RELEASE_SHA="<APPROVED_40_CHARACTER_COMMIT_SHA>"
gh workflow run prepare-release.yml \
  --repo arul28/ADE \
  --ref main \
  -f version="$VERSION" \
  -f target_sha="$RELEASE_SHA"
gh run list \
  --repo arul28/ADE \
  --workflow prepare-release.yml \
  --limit 5
```

Open the new run or use `gh run watch <RUN_ID> --repo arul28/ADE --exit-status`.

The workflow checks out `RELEASE_SHA`, confirms it is on `main`, and requires the successful `ci-pass` result for that exact commit.

The run passes only when:

- The Windows installer is signed by the approved publisher.
- The installer and installed `ADE.exe` use the same certificate.
- The Windows installer, blockmap, and update information match.
- Required bundled tools and runtime files are present.
- The macOS and standalone runtime jobs still pass.
- No GitHub Release is created.

Download the `ade-win-release-v<VERSION>` artifact from the successful run. It must contain exactly:

- `ADE-<VERSION>-win-x64.exe`
- `ADE-<VERSION>-win-x64.exe.blockmap`
- `latest.yml`

### 3. Test the signed installer

On clean Windows 10 x64 and Windows 11 x64 computers:

1. Check the installer signature:

   ```powershell
   Get-AuthenticodeSignature `
     -LiteralPath ".\ADE-<VERSION>-win-x64.exe" |
     Format-List Status,SignerCertificate,TimeStamperCertificate
   ```

2. Install ADE and run the same check on `%LOCALAPPDATA%\Programs\ADE\ADE.exe`.
3. Confirm both results report `Status: Valid` and the approved ADE publisher.
4. Test installation, launch, projects, lanes, agent sessions, terminals, `ade doctor`, the background service, iPhone pairing, uninstall, and reinstall.
5. Record the commit, workflow run, Windows versions, publisher, certificate fingerprint, file SHA-256, and results.

Use the [full Windows test matrix](../development/windows-port-lane.md#external-proof-gates-before-public-availability) for the acceptance test.

### 4. Enable Windows releases

After the recorded test results pass:

```bash
gh variable set ADE_WINDOWS_PUBLIC_RELEASE_ENABLED \
  --repo arul28/ADE --body 1
```

This setting allows the existing release workflow to add validated Windows files to its combined draft. It does not publish a release by itself.

## Publish a release

Use this process for the first Windows release and every later release.

### 1. Approve the commit and version

Confirm:

- The commit is on `main`.
- The normal `ci-pass` check succeeded for that exact commit.
- The version tag does not already exist.
- The signed-build and public-release settings are `1`.

For later releases, run the non-publishing workflow for the approved version and commit. For the first Windows release, reuse the Step 2 result if its version and commit are unchanged.

```bash
VERSION="<VERSION>"
RELEASE_SHA="<APPROVED_40_CHARACTER_COMMIT_SHA>"
gh workflow run prepare-release.yml \
  --repo arul28/ADE \
  --ref main \
  -f version="$VERSION" \
  -f target_sha="$RELEASE_SHA"
```

Do not tag until that run succeeds for `RELEASE_SHA`.

### 2. Tag the approved commit

```bash
VERSION="<VERSION>"
RELEASE_SHA="<APPROVED_40_CHARACTER_COMMIT_SHA>"
git tag -a "v$VERSION" "$RELEASE_SHA" -m "ADE v$VERSION"
git push origin "v$VERSION"
```

The tag starts `.github/workflows/release.yml`. GitHub Actions builds every platform and creates or updates an unpublished GitHub Release.

Do not rerun the release workflow after the release is public. The workflow refuses to overwrite assets on a published release.

### 3. Check the unpublished release

```bash
gh release view "v<VERSION>" \
  --repo arul28/ADE \
  --json tagName,isDraft,url,assets
```

Require:

- The tag points to the approved commit.
- `isDraft` is `true`.
- All existing macOS and standalone runtime files are present.
- The Windows installer, its `.blockmap`, and `latest.yml` are present.
- The downloaded Windows installer and installed `ADE.exe` have valid signatures from the approved publisher.
- The installed app points to `arul28/ADE` for updates.

Stop if any file or check is wrong. Do not upload replacement files by hand and do not move an existing tag. Fix the source, choose a higher version, and repeat the automated process.

### 4. Publish

This command makes every platform's release files public:

```bash
gh release edit "v<VERSION>" \
  --repo arul28/ADE --draft=false --latest
```

Run it only with explicit maintainer approval.

### 5. Enable the website once

For the first public Windows release:

1. In the Vercel project serving `ade-app.dev`, set the Production variable `VITE_ADE_WINDOWS_DOWNLOAD_ENABLED=1`.
2. Redeploy the current `apps/web` commit.
3. Confirm the Windows button opens the latest `arul28/ADE` GitHub Release.
4. Confirm the macOS and iOS links are unchanged.
5. Download and install ADE from that public link on a clean Windows computer.

Later releases use the same website link and do not require another setting change.

After a second signed Windows release exists, verify that an installed older version updates to it. This validates the updater; it is not required infrastructure for publishing the first Windows release.

## If something fails

- Before publication: keep Windows and the website link disabled, fix the problem, and repeat the failed test.
- Existing macOS or standalone runtime job fails: stop the release and fix the shared workflow.
- Problem found in an unpublished release: leave it unpublished, fix the source, choose a higher version, and rebuild.
- Problem found after publication: hide the website link, disable Windows publication, fix and test a higher version, then re-enable Windows before tagging it.
- Signing certificate changes: update the signing secrets and repeat the signed installer tests.
- Release workflow is rerun after publication: the workflow stops instead of replacing public files. Publish a higher version for any correction.

Never put a certificate, private key, password, private certificate URL, or access token in the repository, logs, release notes, or test record.

## Other distribution options

An unsigned `.exe` can be shared for development, but Windows cannot verify who published it. The public GitHub release should use a trusted signature.

WinGet, the Microsoft Store, MSIX, and enterprise deployment can be added later. They are separate distribution channels and are not required to add Windows to ADE's existing GitHub release.

## Implementation files

- [Package scripts](../../apps/desktop/package.json)
- [Windows packaging script](../../apps/desktop/scripts/run-electron-builder.mjs)
- [Windows release-file checker](../../apps/desktop/scripts/validate-win-artifacts.mjs)
- [Non-publishing workflow](../../.github/workflows/prepare-release.yml)
- [Tag-triggered release workflow](../../.github/workflows/release.yml)
- [Shared release jobs](../../.github/workflows/release-core.yml)
- [Contract tests](../../apps/desktop/scripts/windows-release-contract.test.mjs)
- [Update behavior](../features/onboarding-and-settings/desktop-auto-update.md)

## References

- [electron-builder Windows signing](https://www.electron.build/docs/features/code-signing/code-signing-win/)
- [GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [Microsoft code-signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Microsoft SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [Microsoft Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/overview)
