# Maintainer guide: Publish signed Windows builds

Use this guide after the Windows release changes have been merged into `main`.

ADE already publishes macOS and standalone runtime files through GitHub Releases. The Windows release uses that same pipeline and includes the standalone Windows payload.

After setup, a normal release is:

1. A maintainer tags an approved commit.
2. GitHub Actions builds and checks the other platforms, then retrieves and
   verifies the immutable Windows artifact approved by the exact-SHA proof.
3. GitHub Actions creates one unpublished GitHub Release.
4. A maintainer checks it and makes it public.

Nobody builds or uploads the Windows installer by hand.

Each Windows release adds one file for people to download: `ADE-<VERSION>-win-x64.exe`. It also includes two small files used by ADE's automatic updater: the `.blockmap` helps download only what changed, and `latest.yml` identifies and verifies the current installer.

## Start here

Complete these actions in order:

1. Configure the Windows signing credentials in GitHub Actions.
2. Enable signed test builds while keeping Windows publication off.
3. Build a signed test version in GitHub Actions.
4. Complete the exact-SHA proof inventory on clean Windows 10 and Windows 11 computers, including a signed N to N+1 private update.
5. Validate and approve the redacted proof bundle while publication and the website remain disabled.
6. Bind the approved proof SHA, run id, and build-manifest digest, attest the
   installed-update proof, and enable Windows in the production release
   workflow.
7. Tag the approved commit. GitHub Actions builds the other platforms, promotes
   the exact approved Windows artifact, and creates one unpublished release.
8. Check the release, make it public, and only then enable the Windows website link.

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

`prepare-release.yml` is the platform-neutral non-publishing dry run. Pass
`windows_proof=true` to also assert the signed Windows proof preconditions:
`ADE_WINDOWS_SIGNED_BUILD_ENABLED` must be `1` and
`ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` must not be `1`, so proof is always
collected while publication is disabled. Without that input the same workflow
stays the ordinary macOS and standalone runtime validation run and can be
dispatched in any Windows flag state.

Use the version and commit intended for the first Windows release:

```bash
VERSION="<VERSION>"
RELEASE_SHA="<APPROVED_40_CHARACTER_COMMIT_SHA>"
gh workflow run prepare-release.yml \
  --repo arul28/ADE \
  --ref main \
  -f version="$VERSION" \
  -f target_sha="$RELEASE_SHA" \
  -f windows_proof=true
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
- A machine-readable proof manifest is generated for the exact checked-out SHA.

Download the `ade-win-release-v<VERSION>` artifact from the successful run.

> **Retention window.** That artifact is uploaded with `retention-days: 90`. A
> public release promotes those exact bytes, so the tag in Publish step 2 must
> happen within 90 days of this proof run. After that the artifact expires,
> promotion stops with an explicit retention error, and you must repeat steps 2
> through 4 for the approved commit and rebind
> `ADE_WINDOWS_APPROVED_PROOF_RUN_ID` and
> `ADE_WINDOWS_APPROVED_BUILD_MANIFEST_SHA256`.

Its manifest-indexed files must include:

- `ADE-<VERSION>-win-x64.exe`
- `ADE-<VERSION>-win-x64.exe.blockmap`
- `latest.yml`
- `ade-win32-x64.exe`
- `ade-win32-x64.native.tar.gz`
- `install.ps1`
- `SHA256SUMS`
- `windows-proof-manifest.json`

Before editing the manifest, record the immutable build identity:

```powershell
$PROOF_RUN_ID = "<workflow-run-id>"
$BUILD_MANIFEST_SHA256 = (Get-FileHash `
  -LiteralPath <proof-root>\windows-proof-manifest.json `
  -Algorithm SHA256).Hash.ToLowerInvariant()
```

Create the proof-bundle layout from the proof contract: leave the manifest at
the bundle root and place all seven manifest-indexed files under its
`artifacts/` directory before running the validator. Keep any additional
standalone platform files from the Actions artifact unchanged alongside them.

Run the build-phase validator after download. It re-hashes all seven indexed
release files, verifies the standalone entries against `SHA256SUMS`, and
rejects a manifest for any other commit:

```powershell
node apps/desktop/scripts/windows-proof-manifest.mjs validate `
  --manifest <proof-root>\windows-proof-manifest.json `
  --phase build `
  --expected-sha $RELEASE_SHA `
  --artifact-root <proof-root>\artifacts
```

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
4. Test installation, launch, projects, lanes, agent sessions, terminals, `ade doctor`, the HKCU startup supervisor, iPhone pairing, uninstall, and reinstall.
5. Complete every scenario in the machine-readable inventory, including
   Windows 10/11, PowerShell 5.1, PowerShell 7, cmd, Git Bash, every provider state, account OAuth/directory,
   cross-machine clients, LAN/Tailscale/Relay, the private signed N to N+1
   updater path, and regressions.
6. Index separately redacted GUI, log, DB, process, IPC, and network evidence.
   Record publisher/certificate identity as a digest, never raw certificate
   material or personal/account identifiers.

Use the [Windows release proof contract](../development/windows-release-proof.md)
and its [full-system scenario inventory](../development/windows-full-system-scenarios.json)
for the acceptance test. Installed-host recovery guidance lives in
[Windows support](../development/windows-support.md).

### 4. Approve the exact-SHA proof

After every `pre-tag` result is `pass`, evidence is redacted, and the manifest
is `proof_complete`, run the complete validator with the artifact and evidence
roots. Leave `draft-assets-website-explicit` pending until the unpublished draft
exists in Publish step 3. An authorized Windows release maintainer then changes the role-only
approval fields as described in the proof contract and runs
`--phase publication-readiness`. This validation still requires both public
release and website flags to be false.

Set the protected proof binding to the manifest's exact SHA, the original
non-publishing run, and the original build-manifest digest:

```bash
gh variable set ADE_WINDOWS_APPROVED_PROOF_SHA \
  --repo arul28/ADE --body "$RELEASE_SHA"
gh variable set ADE_WINDOWS_APPROVED_PROOF_RUN_ID \
  --repo arul28/ADE --body "$PROOF_RUN_ID"
gh variable set ADE_WINDOWS_APPROVED_BUILD_MANIFEST_SHA256 \
  --repo arul28/ADE --body "$BUILD_MANIFEST_SHA256"
```

The public workflow fails closed if any binding is absent or malformed, if the
SHA or release tag differs, or if the retrieved immutable artifact's manifest
or release-file hashes differ.

### 5. Enable Windows releases

After the recorded test results pass, set both publication gates. They are
separate settings and `release-core.yml` requires both; setting only the public
flag makes the tagged release stop in its `verify` job with
`ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=1 requires approved two-version
installed-update proof.`

```bash
gh variable set ADE_WINDOWS_INSTALLED_UPDATE_PROOF_APPROVED \
  --repo arul28/ADE --body 1
gh variable set ADE_WINDOWS_PUBLIC_RELEASE_ENABLED \
  --repo arul28/ADE --body 1
```

`ADE_WINDOWS_INSTALLED_UPDATE_PROOF_APPROVED=1` is a maintainer attestation, not
a machine check. It states that an authorized Windows release maintainer has
seen and accepted the two-version installed-update proof for this exact commit:
two signed, non-public builds N and N+1 installed on clean Windows 10 x64 and
Windows 11 x64 hosts, with the private N to N+1 updater path completed
end-to-end, including timestamp and signature validation, tamper rejection,
desktop relaunch, brain service recovery, and user data preservation.

Set it only when all of the following are true:

- Every `pre-tag` result in the proof manifest is `pass` and the manifest state
  is `proof_complete` (Step 4).
- The `publication-readiness` validator passed while both the public release and
  website flags were still disabled (Step 4).
- The updater scenarios in the
  [full-system scenario inventory](../development/windows-full-system-scenarios.json)
  that cover the signed N to N+1 private update are recorded as `pass`.
- `ADE_WINDOWS_APPROVED_PROOF_SHA` names the same commit that produced that
  proof.

The supporting evidence lives in the redacted proof bundle assembled in Step 2
and validated in Step 4: `windows-proof-manifest.json` at the bundle root, the
manifest-indexed release files under `artifacts/`, and the redacted GUI, log,
DB, process, IPC, and network evidence under `evidence/`. The contract for both
is [Windows release proof](../development/windows-release-proof.md). Clear this
variable back to `0` whenever the approved proof no longer describes the commit
being released.

These settings allow the existing release workflow to add validated Windows files to its combined draft. They do not publish a release by themselves.
Keep `VITE_ADE_WINDOWS_DOWNLOAD_ENABLED` unset or `0`; website readiness is not
publication approval.

### Required GitHub Actions settings

`release-core.yml` reads exactly these repository variables and secrets. Every
name below is required unless marked optional.

| Repository variable | Required when | Meaning |
| --- | --- | --- |
| `ADE_WINDOWS_SIGNED_BUILD_ENABLED` | Any signed Windows build or proof | `1` runs the signed Windows proof job and signs the standalone `ade-win32-x64.exe`. Set in Step 1. |
| `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` | Publishing Windows files | `1` lets the tagged release promote and attach the Windows files. Set in Step 5. |
| `ADE_WINDOWS_INSTALLED_UPDATE_PROOF_APPROVED` | Publishing Windows files | `1` attests the accepted two-version installed-update proof. Set in Step 5. |
| `ADE_WINDOWS_APPROVED_PROOF_SHA` | Publishing Windows files | The approved 40-character commit SHA. Must equal the commit being released. Set in Step 4. |
| `ADE_WINDOWS_APPROVED_PROOF_RUN_ID` | Publishing Windows files | The non-publishing proof run whose artifact is promoted. Its artifact expires 90 days after that run. Set in Step 4. |
| `ADE_WINDOWS_APPROVED_BUILD_MANIFEST_SHA256` | Publishing Windows files | SHA-256 of the original `windows-proof-manifest.json`. Set in Step 4. |

| Secret | Required when | Meaning |
| --- | --- | --- |
| `WINDOWS_CSC_LINK` | Signed Windows builds | Base64 PFX/P12 or a private HTTPS URL returning it. Step 1. |
| `WINDOWS_CSC_KEY_PASSWORD` | Signed Windows builds | Certificate password. Step 1. |
| `WINDOWS_SIGNING_EXPECTED_SUBJECT` | Signed Windows builds, unless the thumbprint is set | Pinned certificate Subject. Step 1. |
| `WINDOWS_SIGNING_EXPECTED_THUMBPRINT` | Signed Windows builds, unless the subject is set | Pinned certificate fingerprint. Step 1. |
| `CSC_LINK` | Every release | Existing macOS Developer ID certificate. Not used by Windows signing. |
| `CSC_KEY_PASSWORD` | Every release | Existing macOS certificate password. |
| `MACOS_DEVELOPER_ID_PROFILE_B64` | Every release | Existing macOS Developer ID provisioning profile. |
| `APPLE_API_KEY_P8` | Every release | Existing App Store Connect API key material. |
| `APPLE_API_KEY_ID` | Every release | Existing App Store Connect key id. |
| `APPLE_API_ISSUER` | Every release | Existing App Store Connect issuer id, used by notarization. |
| `ADE_POSTHOG_PROJECT_TOKEN` | Optional | Analytics token baked into packaged builds. |
| `ADE_POSTHOG_HOST` | Optional | Analytics host baked into packaged builds. |

`VITE_ADE_WINDOWS_DOWNLOAD_ENABLED` is not a GitHub setting. It is a Vercel
Production variable for the website and is covered in Publish step 5.

## Publish a release

Use this process for the first Windows release and every later release.

### 1. Approve the commit and version

Confirm:

- The commit is on `main`.
- The normal `ci-pass` check succeeded for that exact commit.
- The version tag does not already exist.
- The signed-build and public-release settings are `1`.
- `ADE_WINDOWS_INSTALLED_UPDATE_PROOF_APPROVED` is `1` for this exact commit. It
  is required at every Windows gate in `release-core.yml`; without it the tagged
  run fails in `verify` with `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=1 requires
  approved two-version installed-update proof.` See
  [Required GitHub Actions settings](#required-github-actions-settings).
- `ADE_WINDOWS_APPROVED_PROOF_SHA` equals the approved 40-character commit SHA.
- `ADE_WINDOWS_APPROVED_PROOF_RUN_ID` identifies the approved non-publishing run,
  and that run finished less than 90 days ago so its artifact has not expired.
- `ADE_WINDOWS_APPROVED_BUILD_MANIFEST_SHA256` equals the recorded original
  build-manifest digest.
- The proof manifest passed `publication-readiness` with public release and
  website gates still disabled.

Confirm the current values before tagging:

```bash
gh variable list --repo arul28/ADE | grep ADE_WINDOWS_
```

For later releases, first set `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=0` and
`ADE_WINDOWS_INSTALLED_UPDATE_PROOF_APPROVED=0`, then run the non-publishing
workflow and collect fresh exact-SHA proof for the approved version and commit.
Restore both gates only after that proof is approved. For the first Windows
release, reuse the Step 2 result if its version and commit are unchanged and its
artifact is still within its 90-day retention window.

```bash
VERSION="<VERSION>"
RELEASE_SHA="<APPROVED_40_CHARACTER_COMMIT_SHA>"
gh workflow run prepare-release.yml \
  --repo arul28/ADE \
  --ref main \
  -f version="$VERSION" \
  -f target_sha="$RELEASE_SHA" \
  -f windows_proof=true
```

Do not tag until that run succeeds for `RELEASE_SHA`.

### 2. Tag the approved commit

```bash
VERSION="<VERSION>"
RELEASE_SHA="<APPROVED_40_CHARACTER_COMMIT_SHA>"
git tag -a "v$VERSION" "$RELEASE_SHA" -m "ADE v$VERSION"
git push origin "v$VERSION"
```

The tag starts `.github/workflows/release.yml`. GitHub Actions rebuilds the
other platforms, promotes the exact approved Windows artifact from the
non-publishing run, verifies its immutable identity and hashes, and creates or
updates an unpublished GitHub Release.

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
- The approved proof SHA equals the release target and the downloaded Windows
  files match the proof manifest hashes.
- `SHA256SUMS` lists exactly `install.sh`, `install.ps1`, the four
  `ade-darwin-*` and four `ade-linux-*` files, and `ade-win32-x64.exe` with its
  native archive, and every listed digest matches the uploaded asset.

The draft mixes two runs on purpose, one asset name per run. `install.sh` and
the `ade-darwin-*` and `ade-linux-*` files come from the tagged run, because the
darwin runtime binaries are notarized per run and must be byte-identical to the
copies inside the DMGs beside them. The installer, its `.blockmap`, `latest.yml`,
`install.ps1`, and the signed `ade-win32-x64` files come from the approved proof
run. `SHA256SUMS` is regenerated over that merged set, so it is not the same file
as the `SHA256SUMS` inside the proof artifact.

Add the redacted draft-asset and disabled-website evidence to the proof bundle,
set `draft-assets-website-explicit` to `pass`, then run the final gate:

```powershell
node apps/desktop/scripts/windows-proof-manifest.mjs validate `
  --manifest <proof-root>\windows-proof-manifest.json `
  --phase draft-readiness `
  --expected-sha $RELEASE_SHA `
  --expected-tag "v$VERSION" `
  --expected-run-id $PROOF_RUN_ID `
  --artifact-root <proof-root>\artifacts `
  --evidence-root <proof-root>\evidence
```

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

The N to N+1 updater path must already have been proven with two signed,
non-public builds before the first public Windows release. Repeat it against
public metadata after the next public signed release as an ongoing regression
check; do not weaken the initial proof requirement merely because public N+1
does not exist yet.

## If something fails

- Before publication: keep Windows and the website link disabled, fix the problem, and repeat the failed test.
- Existing macOS or standalone runtime job fails: stop the release and fix the shared workflow.
- Problem found in an unpublished release: leave it unpublished, fix the source, choose a higher version, and rebuild.
- Problem found after publication: hide the website link, disable Windows publication, fix and test a higher version, then re-enable Windows before tagging it.
- Promotion stops with a retention or missing-artifact error: the approved proof
  run is older than its 90-day artifact retention window, its run was deleted, or
  `ADE_WINDOWS_APPROVED_PROOF_RUN_ID` points at the wrong run. Repeat One-time
  setup steps 2 through 4 for the approved commit and rebind
  `ADE_WINDOWS_APPROVED_PROOF_RUN_ID` and
  `ADE_WINDOWS_APPROVED_BUILD_MANIFEST_SHA256`. Never hand-upload a replacement.
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
- [Windows uninstall cleanup](../../apps/desktop/scripts/windows-uninstall-cleanup.ps1)
- [Non-publishing workflow](../../.github/workflows/prepare-release.yml)
- [Tag-triggered release workflow](../../.github/workflows/release.yml)
- [Shared release jobs](../../.github/workflows/release-core.yml)
- [Contract tests](../../apps/desktop/scripts/windows-release-contract.test.mjs)
- [Proof manifest generator and validator](../../apps/desktop/scripts/windows-proof-manifest.mjs)
- [Exact-SHA Windows proof](../development/windows-release-proof.md)
- [Windows support and troubleshooting](../development/windows-support.md)
- [Update behavior](../features/onboarding-and-settings/desktop-auto-update.md)

## References

- [electron-builder Windows signing](https://www.electron.build/docs/features/code-signing/code-signing-win/)
- [GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [Microsoft code-signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Microsoft SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [Microsoft Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/overview)
