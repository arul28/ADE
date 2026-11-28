# Maintainer guide: signed Windows builds

DAEX publishes Windows through the same GitHub Release pipeline as macOS and the
standalone runtime. Windows builds fresh on every beta and stable tag, signed and
validated in CI. Nobody builds or uploads the Windows installer by hand.

A normal release:

1. `beta.yml` builds, signs and publishes a beta (`vX.Y.Z-beta.N`) from a green
   `main` commit, Windows included.
2. A maintainer picks the newest beta that passes the Sentry gate
   (`bash scripts/release-tools/betas.sh`) and pushes the stable tag at that
   beta's commit.
3. GitHub Actions builds, signs and validates every platform from that tag and
   creates one unpublished GitHub Release.
4. A maintainer checks it and makes it public.

The release skill (`.agents/skills/release/SKILL.md`) runs these steps. This
guide holds the Windows-specific setup, checks and failure handling.

Each Windows release adds `ADE-<VERSION>-win-x64.exe` (the file name keeps
`ADE`), plus the updater's `.blockmap` and `latest.yml`, and the standalone
`ade-win32-x64.exe`, its native archive and `install.ps1`.

## Signing setup

Windows signing runs on
[Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/overview)
(formerly Trusted Signing). There is no certificate file: the service keeps the
certificate and signs on behalf of a Microsoft Entra service principal.

**Certificates rotate.** The service
[renews the certificate daily with a 72-hour validity](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-certificate-management):

- The publisher is pinned by **certificate Subject**, never thumbprint.
  `verify`, `prepare-release.yml`, `run-electron-builder.mjs`,
  `validate-win-artifacts.mjs` and `sign-windows-runtime.ps1` each fail while a
  `WINDOWS_SIGNING_EXPECTED_THUMBPRINT` secret exists.
- Every signature is RFC3161 timestamped against
  `http://timestamp.acs.microsoft.com`, or a shipped installer would stop
  verifying three days after it was built.

### Azure resources

These exist. Recreate them only if the account is rebuilt.

| | |
| --- | --- |
| Signing account | `arulsigning` |
| Resource group | `rg-signing` |
| Region | East US |
| Signing endpoint | `https://eus.codesigning.azure.net` |
| Certificate profile | `adePublicTrust` (Public Trust) |
| Certificate subject | `CN=Arul Sharma, O=Arul Sharma, L=Greensboro, S=nc, C=US` |

The service principal `ade-signing-ci` holds the **Artifact Signing
Certificate Profile Signer** role on the signing account; without it signing
fails with HTTP 403. The endpoint, account and profile are pinned in
`apps/desktop/scripts/run-electron-builder.mjs` and
`apps/ade-cli/scripts/sign-windows-runtime.ps1`;
`WINDOWS_SIGNING_ENDPOINT`, `WINDOWS_SIGNING_ACCOUNT_NAME` and
`WINDOWS_SIGNING_CERTIFICATE_PROFILE` override them for a fork.

### GitHub Actions settings

`release-core.yml` reads these. Every name is required unless marked optional.

| Repository variable | Meaning |
| --- | --- |
| `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` | `1` (set) makes every tagged release build, sign, validate and attach Windows. `0` removes Windows from later releases and leaves other platforms unchanged. The only Windows gate; the website download has no flag. |

| Secret | Meaning |
| --- | --- |
| `AZURE_TENANT_ID` | Entra tenant of the signing account. |
| `AZURE_CLIENT_ID` | Client id of `ade-signing-ci`. |
| `AZURE_CLIENT_SECRET` | Client secret for `ade-signing-ci`. |
| `WINDOWS_SIGNING_EXPECTED_SUBJECT` | The pinned certificate Subject, exactly as Windows reports it, and the `publisherName` the packaged updater verifies. |
| `CSC_LINK`, `CSC_KEY_PASSWORD`, `MACOS_DEVELOPER_ID_PROFILE_B64` | macOS Developer ID material. Windows signing never reads them; the packaging wrapper strips them from electron-builder's environment. |
| `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect key, used by notarization. |
| `ADE_POSTHOG_PROJECT_TOKEN`, `ADE_POSTHOG_HOST` | Optional analytics baked into packaged builds. |

```bash
gh secret set AZURE_TENANT_ID --repo arul28/ADE   # prompts; never put the value in the command
```

The three `AZURE_*` names are what Azure.Identity's `EnvironmentCredential`
reads, first in the `DefaultAzureCredential` chain. An incomplete triple falls
through to a managed-identity probe the GitHub runner cannot answer and fails
slowly (`CredentialUnavailableException`), so `verify` requires all three up
front. A missing secret stops the tagged run about a minute in, in `verify`,
with `Windows releases require the AZURE_TENANT_ID, AZURE_CLIENT_ID and
AZURE_CLIENT_SECRET secrets.` or `Windows releases require the
WINDOWS_SIGNING_EXPECTED_SUBJECT secret to pin the approved publisher.`
`prepare-release.yml` reads the four signing secrets directly when
`windows_proof` is set and passes the rest with `secrets: inherit`.

### What signs

electron-builder 26's `win.azureSignOptions`, supplied by
`run-electron-builder.mjs` on the `--require-signing` path only. electron-builder
routes every Windows artifact through one signing manager, so one configuration
signs the packaged `ADE.exe` and its DLLs, the NSIS installer and the
uninstaller. A post-build signing action could only sign the finished installer
and would leave the embedded `ADE.exe` unsigned.

electron-builder installs the `TrustedSigning` PowerShell module from PSGallery
on the runner and calls `Invoke-TrustedSigning` per file;
`sign-windows-runtime.ps1` signs `ade-win32-x64.exe` the same way. So:

- The runner needs PSGallery and nuget.org on every signed build (nothing is
  vendored).
- Microsoft's successor is `ArtifactSigning` / `Invoke-ArtifactSigning`; move
  the desktop build and the runtime signer together when electron-builder does.

Signing is machine-enforced whenever Windows builds: `build-win-release`
requires the secrets before packaging, `run-electron-builder.mjs` runs with
`--require-signing`, and `validate-win-artifacts.mjs --require-signed` checks a
valid signature, a trusted RFC3161 timestamp, the pinned Subject, and that the
installer and the `ADE.exe` it installs carry the same certificate. There is no
unsigned publication path.

## Clean-host proof (regression check)

The pipeline does not require a clean-host sweep, so a release can publish
Windows bytes no human installed on a clean machine. Run one when the Windows
install, service or signing paths changed:

```bash
gh workflow run prepare-release.yml --repo arul28/ADE --ref main \
  -f version="<VERSION>" -f target_sha="<40_CHARACTER_SHA>" -f windows_proof=true
```

The run checks out the SHA, confirms it is on `main` with a successful
`ci-pass`, builds and signs without creating a release, runs the
installed-product lifecycle smoke, and uploads `ade-win-proof-v<VERSION>` (kept
90 days) plus `ade-win-release-v<VERSION>` (installer, `.blockmap`,
`latest.yml`). Record the run id. Then follow
[windows-release-proof.md](../development/windows-release-proof.md): lay out the
bundle, run the `build` phase validator, test on clean Windows 10 and 11 hosts
(signature check below, install, launch, projects, lanes, agents, terminals,
`daex doctor`, the HKCU supervisor, iPhone pairing, uninstall, reinstall, and
every scenario in the inventory), index redacted evidence, and run the `complete`
and `publication-readiness` phases.

```powershell
Get-AuthenticodeSignature -LiteralPath ".\ADE-<VERSION>-win-x64.exe" |
  Format-List Status,SignerCertificate,TimeStamperCertificate
```

Run the same check on `%LOCALAPPDATA%\Programs\ADE\ADE.exe`; both must report
`Status: Valid` and the approved publisher.

## Publish a release

### 1. Approve the commit and version

The commit is the commit of the beta you promote:

```bash
bash scripts/release-tools/betas.sh                          # the recommended: line names the beta
node scripts/release-tools/beta-gate.mjs v<VERSION>-beta.<N>  # exit 0 is PASS
RELEASE_SHA=$(git rev-list -n 1 v<VERSION>-beta.<N>)
```

Do not promote a beta that the gate failed (exit 1) or could not check (exit 2).
Confirm the commit is on `main` with a successful `ci-pass`, the tag does not
exist, `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED` is `1`
(`gh variable list --repo arul28/ADE | grep ADE_WINDOWS_`), and the
`ade-signing-ci` client secret has not expired.

The beta already built, signed and validated Windows from this commit, so a dry
run (`prepare-release.yml` without `windows_proof`) is optional; run it when the
signing setup changed since that beta, and do not tag until it passes.

### 2. Tag the approved commit

Push the tag yourself. The "Protect release tags" rule lets only an admin create
a stable `v*` tag. Do not dispatch `release.yml` with `target_sha` instead: the
workflow's token cannot create the tag (HTTP 422), and a dispatch plus a push
start two runs.

```bash
git tag -a "v$VERSION" "$RELEASE_SHA" -m "DAEX v$VERSION"
git push origin "v$VERSION"
```

The tag starts `.github/workflows/release.yml`, which builds every platform and
creates an unpublished release. While the gate is on, a failed or skipped
Windows build blocks the draft like a failed macOS build. The workflow refuses to
overwrite assets on a published release.

### 3. Check the unpublished release

```bash
gh release view "v<VERSION>" --repo arul28/ADE --json tagName,isDraft,url,assets
```

Require:

- The tag points to the approved commit, and `isDraft` is `true`.
- All macOS and standalone runtime files are present, plus the Windows
  installer, `.blockmap` and `latest.yml`.
- The downloaded installer and installed `ADE.exe` have valid signatures from
  the approved publisher, and the installed app updates from `arul28/ADE`.
- `SHA256SUMS` lists exactly `install.sh`, `install.ps1`, the four
  `ade-darwin-*` and four `ade-linux-*` files, and `ade-win32-x64.exe` with its
  native archive, and every digest matches the uploaded asset.

When a clean-host sweep runs for this release, add the draft-asset evidence, set
`draft-assets-website-explicit` to `pass`, and run the `draft-readiness` phase
with `--expected-tag "v$VERSION" --expected-run-id <proof run id>` (see
windows-release-proof.md).

Stop if anything is wrong. Never upload replacement files or move a tag: fix the
source, choose a higher version, and repeat.

### 4. Publish

```bash
gh release edit "v<VERSION>" --repo arul28/ADE --draft=false --latest
```

Run it only with explicit maintainer approval.

### 5. Confirm the website

The website's `/download/windows` must resolve to the installer you published
and `https://ade-app.dev/install.ps1` must serve the matching script; the macOS
and iOS links stay unchanged. Install from the public link on a clean Windows
computer.

## If something fails

- A macOS or standalone runtime job fails: stop and fix the shared workflow.
- Publish fails with `Reference update failed (HTTP 422)`: the run tried to
  create the stable tag. Push `v<VERSION>` at the run's commit, then
  `gh run rerun <RUN_ID> --failed`.
- A source fix reaches stable only through a new beta: merge it, let `beta.yml`
  publish the next beta, and promote that one.
- `build-win-release` fails while the gate is on: no draft is created. Fix the
  source, choose a higher version, tag again. Never turn the gate off to force a
  draft out.
- Gate on but the draft has no Windows assets, or gate off but it has some: the
  draft did not come from a complete run. Leave it unpublished, delete it, rerun.
- A problem after publication: set `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=0`, fix
  and test a higher version, set it back to `1` before tagging.
- `Windows installer and packaged executable were signed by different
  certificates`: the build straddled the daily rotation. Rerun it.
- HTTP 403 while signing: `ade-signing-ci` lost its role or its client secret
  expired.
- `CredentialUnavailableException`, or a hang before signing: one of the three
  `AZURE_*` secrets is missing or wrong.
- Installing the `TrustedSigning` module fails: the runner could not reach
  PSGallery or nuget.org.
- The certificate profile's Subject changed (rotation alone does not change it):
  update `WINDOWS_SIGNING_EXPECTED_SUBJECT` and repeat the signature checks.

Never put a certificate, key, password, private URL or token in the repository,
logs, release notes or a test record.

## Implementation files

- `apps/desktop/package.json` (`build.win`, `build.nsis`)
- `apps/desktop/scripts/run-electron-builder.mjs` (packaging and signing)
- `apps/desktop/scripts/validate-win-artifacts.mjs` (release-file checks)
- `apps/ade-cli/scripts/sign-windows-runtime.ps1` (standalone runtime signer)
- `apps/desktop/scripts/windows-uninstall-cleanup.ps1`
- `.github/workflows/prepare-release.yml`, `release.yml`, `release-core.yml`,
  `release-publish.yml`
- `apps/desktop/scripts/windows-release-contract.test.mjs`
  (`npm --prefix apps/desktop run test:win:release-contract`)
- `apps/desktop/scripts/windows-proof-manifest.mjs`
- [Windows release proof](../development/windows-release-proof.md),
  [Windows support](../development/windows-support.md),
  [Update behavior](../features/onboarding-and-settings/desktop-auto-update.md)

## References

- [Azure Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)
- [Azure Artifact Signing role assignment](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles)
- [Azure Identity credential chains](https://learn.microsoft.com/en-us/dotnet/azure/sdk/authentication/credential-chains)
- [electron-builder Windows signing](https://www.electron.build/docs/features/code-signing/code-signing-win/)
- [Microsoft SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
