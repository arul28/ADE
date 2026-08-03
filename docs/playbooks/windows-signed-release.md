# Maintainer guide: Publish signed Windows builds

Use this guide after the Windows release changes have been merged into `main`.

ADE already publishes macOS and standalone runtime files through GitHub Releases. Windows uses that same pipeline and includes the standalone Windows payload. Windows builds fresh on the release tag, the same way macOS does.

After setup, a normal release is:

1. A maintainer tags an approved commit.
2. GitHub Actions builds, signs, and validates every platform from that tag,
   including Windows.
3. GitHub Actions creates one unpublished GitHub Release.
4. A maintainer checks it and makes it public.

Nobody builds or uploads the Windows installer by hand.

Each Windows release adds one file for people to download: `ADE-<VERSION>-win-x64.exe`. It also includes two small files used by ADE's automatic updater: the `.blockmap` helps download only what changed, and `latest.yml` identifies and verifies the current installer.

## Start here

Complete these actions in order:

1. Configure the Windows signing credentials in GitHub Actions.
2. Build a signed Windows version in GitHub Actions with the non-publishing
   proof run.
3. Complete the exact-SHA proof inventory on clean Windows 10 and Windows 11
   computers, including a signed N to N+1 private update.
4. Validate and approve the redacted proof bundle while publication and the
   website remain disabled.
5. Set `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=1`. That single switch makes tagged
   releases publish Windows.
6. Tag the approved commit. GitHub Actions builds every platform from that tag
   and creates one unpublished release.
7. Check the release, make it public, and only then enable the Windows website
   link.

The sections below provide the commands and pass conditions.

## One-time setup

Perform these actions once before the first public Windows release.

Step 1 is required. Without the signing secrets no Windows build runs at all.

Steps 2 through 4 are the clean-host proof sweep. They are strongly recommended
before you enable Windows, and worth repeating after enablement as an ongoing
regression check. The pipeline does not enforce them. Nothing in
`release-core.yml` checks that a sweep happened, so a release can publish
Windows bytes that no human ever installed on a clean machine. That is the
accepted tradeoff for having every desktop and CLI release publish Windows
automatically.

### 1. Configure signing

Windows signing runs on [Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/overview), the service Microsoft previously called Trusted Signing.

There is no certificate file to hold. Since June 2023 the CA/Browser Forum has required code-signing private keys to live on FIPS-validated hardware, so exportable `.pfx` delivery ended for OV and EV certificates alike, and this service never releases the certificate at all: [*"All certificates are securely stored within the service and are accessible only at the time of signing."*](https://learn.microsoft.com/en-us/azure/artifact-signing/faq) The build authenticates as a Microsoft Entra service principal and the service signs on its behalf.

**Certificates rotate.** Azure Artifact Signing [renews the certificate daily and issues it with a 72-hour validity](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-certificate-management). Two consequences run through this whole guide:

- The approved publisher is pinned by **certificate Subject**, never by thumbprint. A pinned thumbprint would stop matching within days. `WINDOWS_SIGNING_EXPECTED_THUMBPRINT` is not merely unused — every layer of the pipeline refuses to run while it is set, so the pin cannot quietly become meaningless.
- Every signature is RFC3161 timestamped against `http://timestamp.acs.microsoft.com`. Without that countersignature a shipped installer would stop verifying three days after it was built.

#### The Azure resources

These already exist. Recreate them only if the account is rebuilt.

| | |
| --- | --- |
| Signing account | `arulsigning` |
| Resource group | `rg-signing` |
| Region | East US |
| Signing endpoint | `https://eus.codesigning.azure.net` |
| Certificate profile | `adePublicTrust` (Public Trust) |
| Certificate subject | `CN=Arul Sharma, O=Arul Sharma, L=Greensboro, S=nc, C=US` |

The signing service principal is `ade-signing-ci`. It holds the **Artifact Signing Certificate Profile Signer** role scoped to the signing account; without that role signing fails with HTTP 403.

The endpoint, account name, and certificate profile are not secrets. They are pinned in `run-electron-builder.mjs` and `sign-windows-runtime.ps1` so a maintainer running a signed build locally uses the same values CI does. `WINDOWS_SIGNING_ENDPOINT`, `WINDOWS_SIGNING_ACCOUNT_NAME`, and `WINDOWS_SIGNING_CERTIFICATE_PROFILE` override them for a fork or a migrated account.

#### The GitHub Actions secrets

Add these four:

- `AZURE_TENANT_ID`: the Microsoft Entra tenant (directory) ID.
- `AZURE_CLIENT_ID`: the `ade-signing-ci` app registration's client (application) ID.
- `AZURE_CLIENT_SECRET`: a client secret generated for that app registration.
- `WINDOWS_SIGNING_EXPECTED_SUBJECT`: the certificate profile's complete Subject, exactly as Windows reports it — `CN=Arul Sharma, O=Arul Sharma, L=Greensboro, S=nc, C=US`.

```bash
gh secret set AZURE_TENANT_ID --repo arul28/ADE
gh secret set AZURE_CLIENT_ID --repo arul28/ADE
gh secret set AZURE_CLIENT_SECRET --repo arul28/ADE
gh secret set WINDOWS_SIGNING_EXPECTED_SUBJECT --repo arul28/ADE
```

Each command asks for the secret without printing it in the command.

The three `AZURE_*` names are exactly what Azure.Identity's `EnvironmentCredential` reads. On a GitHub-hosted runner that matters: `EnvironmentCredential` is first in the `DefaultAzureCredential` chain, so a complete service-principal triple is resolved before any managed-identity probe against an Azure instance-metadata endpoint the runner does not have. Microsoft's [FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq) gives the same guidance for non-Azure hosts and notes that when the chain does reach managed identity off-Azure it raises `Azure.Identity.CredentialUnavailableException`. An incomplete triple therefore fails slowly and confusingly rather than cleanly, which is why `verify` requires all three up front.

If `WINDOWS_SIGNING_EXPECTED_SUBJECT` is missing, or if a leftover `WINDOWS_SIGNING_EXPECTED_THUMBPRINT` secret still exists, the run fails in `verify` about a minute in. Delete the thumbprint secret if it is still present:

```bash
gh secret delete WINDOWS_SIGNING_EXPECTED_THUMBPRINT --repo arul28/ADE
```

`CSC_LINK` and `CSC_KEY_PASSWORD` are the macOS Developer ID secrets. Windows signing does not read them, and the packaging wrapper strips both from the electron-builder environment so they can never be picked up as a Windows signing identity.

Keep `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` unset or `0` until Step 5.

#### What actually signs

`electron-builder` 26.8.1 has first-class support for this service through `win.azureSignOptions`. `run-electron-builder.mjs` supplies it on the `--require-signing` path only. That choice matters: electron-builder selects the Azure signing manager above the single chokepoint every Windows artifact passes through, so one configuration covers the packaged `ADE.exe` and its bundled DLLs, the NSIS installer, and the uninstaller. A separate post-build signing step — for example Microsoft's `Azure/artifact-signing-action` — runs after packaging, and could only sign the finished installer, leaving the `ADE.exe` already embedded inside it unsigned unless the installer were unpacked and rebuilt.

Under the hood electron-builder 26 installs the `TrustedSigning` PowerShell module from PSGallery on the runner and calls `Invoke-TrustedSigning` per file. `sign-windows-runtime.ps1` signs the standalone `ade-win32-x64.exe` the same way, so both Windows artifacts share one signing path. Two things follow from that:

- The runner needs outbound access to PSGallery and nuget.org on every signed build. There is no vendored copy.
- Microsoft's successor module is `ArtifactSigning` / `Invoke-ArtifactSigning`. electron-builder pins the older `TrustedSigning` module and only moves off it in v27, which replaces the module with `signtool /dlib`. Migrate the desktop build and the runtime signer together so the two Windows artifacts never diverge.

### 2. Run the signed proof build in GitHub Actions

`prepare-release.yml` is the platform-neutral non-publishing dry run. Pass
`windows_proof=true` to build and sign Windows and emit the exact-SHA proof
bundle. Proof mode reads no repository variable; it only requires the signing
secrets. Collect proof before Windows is enabled, and again after it is enabled
as a regression check. Without that input the same workflow stays the ordinary
dry run, which still builds and validates Windows whenever
`ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` is `1` and skips Windows otherwise. Neither
mode creates a GitHub Release.

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
- The installed-product lifecycle smoke test passes on the runner.
- Required bundled tools and runtime files are present.
- The macOS and standalone runtime jobs still pass.
- No GitHub Release is created.
- A machine-readable proof manifest is generated for the exact checked-out SHA.

Download the `ade-win-proof-v<VERSION>` artifact from the successful run. The
separate `ade-win-release-v<VERSION>` artifact from the same run holds only the
installer, its `.blockmap`, and `latest.yml`; that is the artifact a publishing
run attaches to the draft.

> **Retention window.** The proof bundle is uploaded with `retention-days: 90`.
> That window bounds how long the clean-host evidence stays downloadable for
> human review. It does not bound when you may tag a release. A release never
> reuses bytes from this run, so an expired proof bundle cannot block a release.
> It only means the evidence must be collected again if you still need it.

Record the run id. The final proof phase in Publish step 3 checks the manifest
against it:

```powershell
$PROOF_RUN_ID = "<workflow-run-id>"
```

The bundle's manifest-indexed files must include:

- `ADE-<VERSION>-win-x64.exe`
- `ADE-<VERSION>-win-x64.exe.blockmap`
- `latest.yml`
- `ade-win32-x64.exe`
- `ade-win32-x64.native.tar.gz`
- `install.ps1`
- `SHA256SUMS`
- `windows-proof-manifest.json`

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
release and website flags to be false, so run it before Step 5.

The supporting evidence lives in the redacted proof bundle assembled in Step 2:
`windows-proof-manifest.json` at the bundle root, the manifest-indexed release
files under `artifacts/`, and the redacted GUI, log, DB, process, IPC, and
network evidence under `evidence/`. The contract for both is
[Windows release proof](../development/windows-release-proof.md).

### 5. Enable Windows releases

After the recorded test results pass, set the single publication gate:

```bash
gh variable set ADE_WINDOWS_PUBLIC_RELEASE_ENABLED \
  --repo arul28/ADE --body 1
```

`ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=1` makes every tagged release build, sign,
validate, and publish Windows alongside macOS and the standalone runtime. It is
the only Windows repository variable. Setting it back to `0` removes Windows
from later releases and leaves the other platforms unchanged.

The gate does not publish a release by itself; the release workflow still stops
at an unpublished draft. Keep `VITE_ADE_WINDOWS_DOWNLOAD_ENABLED` unset or `0`;
website readiness is not publication approval.

Signing stays mandatory and machine-enforced whenever Windows builds. The
`build-win-release` job requires the signing secrets before it packages
anything, `run-electron-builder.mjs` runs with `--require-signing`, and
`validate-win-artifacts.mjs` runs `--require-signed` Authenticode verification:
valid signature status, a trusted RFC3161 timestamp, and the pinned publisher
Subject. It additionally requires that the installer and the `ADE.exe` it
installs carry the same certificate, which proves both came from one signing
operation rather than only sharing a Subject. There is no unsigned Windows
publication path.

### Required GitHub Actions settings

`release-core.yml` reads exactly these repository variables and secrets. Every
name below is required unless marked optional.

| Repository variable | Required when | Meaning |
| --- | --- | --- |
| `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` | Publishing Windows files | `1` makes the tagged release build, sign, validate, and attach the Windows files. Set in Step 5. |

| Secret | Required when | Meaning |
| --- | --- | --- |
| `AZURE_TENANT_ID` | Signed Windows builds | Microsoft Entra tenant ID of the Azure Artifact Signing account. Step 1. |
| `AZURE_CLIENT_ID` | Signed Windows builds | Client ID of the `ade-signing-ci` service principal. Step 1. |
| `AZURE_CLIENT_SECRET` | Signed Windows builds | Client secret for that service principal. Step 1. |
| `WINDOWS_SIGNING_EXPECTED_SUBJECT` | Signed Windows builds | Pinned certificate Subject, and the `publisherName` the packaged updater verifies. Step 1. |
| `CSC_LINK` | Every release | Existing macOS Developer ID certificate. Not used by Windows signing. |
| `CSC_KEY_PASSWORD` | Every release | Existing macOS certificate password. |
| `MACOS_DEVELOPER_ID_PROFILE_B64` | Every release | Existing macOS Developer ID provisioning profile. |
| `APPLE_API_KEY_P8` | Every release | Existing App Store Connect API key material. |
| `APPLE_API_KEY_ID` | Every release | Existing App Store Connect key id. |
| `APPLE_API_ISSUER` | Every release | Existing App Store Connect issuer id, used by notarization. |
| `ADE_POSTHOG_PROJECT_TOKEN` | Optional | Analytics token baked into packaged builds. |
| `ADE_POSTHOG_HOST` | Optional | Analytics host baked into packaged builds. |

`WINDOWS_SIGNING_EXPECTED_THUMBPRINT` is not in this table because it is not
supported. Azure Artifact Signing renews the certificate daily and expires it
after 72 hours, so a thumbprint pin would fail every release within days.
`verify`, `prepare-release.yml`, `run-electron-builder.mjs`,
`validate-win-artifacts.mjs`, and `sign-windows-runtime.ps1` each fail while that
secret exists, rather than ignoring it and leaving the release apparently pinned.

`prepare-release.yml` reads the four Windows signing secrets directly when
`windows_proof` is set, and passes everything else through with
`secrets: inherit`.

`VITE_ADE_WINDOWS_DOWNLOAD_ENABLED` is not a GitHub setting. It is a Vercel
Production variable for the website and is covered in Publish step 5.

## Publish a release

Use this process for the first Windows release and every later release.

### 1. Approve the commit and version

Confirm:

- The commit is on `main`.
- The normal `ci-pass` check succeeded for that exact commit.
- The version tag does not already exist.
- `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` is `1`.
- The four Windows signing secrets are still present, and the
  `ade-signing-ci` client secret has not expired. With the gate on and a secret
  missing, the tagged run stops about a minute in, in `verify`, with
  `Windows releases require the AZURE_TENANT_ID, AZURE_CLIENT_ID and
  AZURE_CLIENT_SECRET secrets.` or `Windows releases require the
  WINDOWS_SIGNING_EXPECTED_SUBJECT secret to pin the approved publisher.` See
  [Required GitHub Actions settings](#required-github-actions-settings).

Confirm the current value before tagging:

```bash
gh variable list --repo arul28/ADE | grep ADE_WINDOWS_
```

Run the non-publishing dry run for the exact version and commit first. With the
gate on it builds, signs, and validates Windows too:

```bash
VERSION="<VERSION>"
RELEASE_SHA="<APPROVED_40_CHARACTER_COMMIT_SHA>"
gh workflow run prepare-release.yml \
  --repo arul28/ADE \
  --ref main \
  -f version="$VERSION" \
  -f target_sha="$RELEASE_SHA"
```

Add `-f windows_proof=true` when you also want a fresh clean-host proof bundle
for this commit. That is the recommended regression check, not a requirement.

Do not tag until that run succeeds for `RELEASE_SHA`.

### 2. Tag the approved commit

```bash
VERSION="<VERSION>"
RELEASE_SHA="<APPROVED_40_CHARACTER_COMMIT_SHA>"
git tag -a "v$VERSION" "$RELEASE_SHA" -m "ADE v$VERSION"
git push origin "v$VERSION"
```

The tag starts `.github/workflows/release.yml`. GitHub Actions builds, signs,
and validates every platform from that tag, including Windows when the gate is
on, and creates or updates an unpublished GitHub Release.

While the gate is on, a failed or skipped Windows build blocks the draft exactly
as a failed macOS build does. No draft is created.

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
- `SHA256SUMS` lists exactly `install.sh`, `install.ps1`, the four
  `ade-darwin-*` and four `ade-linux-*` files, and `ade-win32-x64.exe` with its
  native archive, and every listed digest matches the uploaded asset.

Every asset in the draft comes from the tagged run. The published Windows assets
are `ADE-<VERSION>-win-x64.exe`, its `.blockmap`, `latest.yml`, `install.ps1`,
`ade-win32-x64.exe`, and `ade-win32-x64.native.tar.gz`. `SHA256SUMS` is
regenerated over that merged standalone set, so it is not the same file as the
`SHA256SUMS` inside any proof bundle.

Only when you are running the clean-host proof sweep for this release: add the
redacted draft-asset and disabled-website evidence to the proof bundle, set
`draft-assets-website-explicit` to `pass`, then run the final gate against the
bundle from that sweep's proof run:

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

Prove the N to N+1 updater path with two signed, non-public builds before the
first public Windows release. Repeat it against public metadata after the next
public signed release as an ongoing regression check.

## If something fails

- Before publication: keep Windows and the website link disabled, fix the problem, and repeat the failed test.
- Existing macOS or standalone runtime job fails: stop the release and fix the shared workflow.
- `build-win-release` fails while the gate is on: no draft is created, because
  the publish gate in `release.yml` requires a successful Windows build. Fix the source, choose a
  higher version, and tag again. Do not turn the gate off to force a draft out.
- Gate is on but the draft carries no Windows assets: the draft did not come
  from a complete run of this workflow. Leave it unpublished, delete it, and
  rerun the release for that tag.
- Gate is off but the draft carries Windows assets: the assets are stale or were
  added by hand. Leave it unpublished, delete it, and rerun the release for that
  tag with the intended gate value.
- Problem found in an unpublished release: leave it unpublished, fix the source, choose a higher version, and rebuild.
- Problem found after publication: hide the website link, set
  `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=0`, fix and test a higher version, then
  set it back to `1` before tagging that version.
- Signing certificate changes: the certificate rotates on its own and needs no
  action. Update `WINDOWS_SIGNING_EXPECTED_SUBJECT` and repeat the signed
  installer tests only if the certificate profile's Subject itself changes.
- `Windows installer and packaged executable were signed by different
  certificates`: the build straddled the service's daily certificate rotation.
  Nothing is wrong with the configuration. Rerun the build.
- Signing fails with HTTP 403: the `ade-signing-ci` service principal has lost
  the **Artifact Signing Certificate Profile Signer** role on the `arulsigning`
  account, or its client secret expired.
- Signing fails with `CredentialUnavailableException` or hangs before signing:
  one of `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` is missing
  or wrong, so the credential chain fell past `EnvironmentCredential` and tried
  to reach an Azure instance-metadata endpoint the runner does not have.
- The build fails installing the `TrustedSigning` module: the runner could not
  reach PSGallery or nuget.org. The signing toolchain is downloaded per build
  and is not vendored.
- Release workflow is rerun after publication: the workflow stops instead of replacing public files. Publish a higher version for any correction.

Never put a certificate, private key, password, private certificate URL, or access token in the repository, logs, release notes, or test record.

## Other distribution options

An unsigned `.exe` can be shared for development, but Windows cannot verify who published it. The public GitHub release should use a trusted signature.

WinGet, the Microsoft Store, MSIX, and enterprise deployment can be added later. They are separate distribution channels and are not required to add Windows to ADE's existing GitHub release.

## Implementation files

- [Package scripts](../../apps/desktop/package.json)
- [Windows packaging script](../../apps/desktop/scripts/run-electron-builder.mjs)
- [Windows release-file checker](../../apps/desktop/scripts/validate-win-artifacts.mjs)
- [Standalone Windows runtime signer](../../apps/ade-cli/scripts/sign-windows-runtime.ps1)
- [Windows uninstall cleanup](../../apps/desktop/scripts/windows-uninstall-cleanup.ps1)
- [Non-publishing workflow](../../.github/workflows/prepare-release.yml)
- [Tag-triggered release workflow](../../.github/workflows/release.yml)
- [Shared release jobs](../../.github/workflows/release-core.yml)
- [Publishing workflow](../../.github/workflows/release-publish.yml)
- [Contract tests](../../apps/desktop/scripts/windows-release-contract.test.mjs)
- [Proof manifest generator and validator](../../apps/desktop/scripts/windows-proof-manifest.mjs)
- [Exact-SHA Windows proof](../development/windows-release-proof.md)
- [Windows support and troubleshooting](../development/windows-support.md)
- [Update behavior](../features/onboarding-and-settings/desktop-auto-update.md)

## References

- [Azure Artifact Signing overview](https://learn.microsoft.com/en-us/azure/artifact-signing/overview)
- [Azure Artifact Signing certificate management](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-certificate-management)
- [Azure Artifact Signing signing integrations](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations)
- [Azure Artifact Signing role assignment](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles)
- [Azure Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)
- [Azure Identity credential chains](https://learn.microsoft.com/en-us/dotnet/azure/sdk/authentication/credential-chains)
- [electron-builder Windows signing](https://www.electron.build/docs/features/code-signing/code-signing-win/)
- [GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [Microsoft code-signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Microsoft SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
