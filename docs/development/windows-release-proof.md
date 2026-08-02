# Windows release proof

Windows public availability is gated by a machine-readable proof bundle for one
exact source commit. A green package job is necessary but not sufficient: the
bundle joins the signed artifacts to clean-host observations and independently
re-hashes every indexed file before a maintainer can mark the commit approved.

The proof workflow never publishes a GitHub Release and never enables the
website. Keep `ADE_WINDOWS_PUBLIC_RELEASE_ENABLED=0` and
`VITE_ADE_WINDOWS_DOWNLOAD_ENABLED` unset or `0` while collecting and approving
proof for the initial Windows release. For an already-public Windows channel,
disable the repository publication gate before preparing the next release;
website rollback policy is a separate maintainer decision because taking down
the existing approved download may disrupt users.

## Inputs and outputs

Run `.github/workflows/prepare-release.yml` with a version and the lowercase,
40-character commit SHA intended for release. The workflow requires
`ADE_WINDOWS_SIGNED_BUILD_ENABLED=1`, refuses to run when public Windows
publication is enabled, checks out the exact SHA, verifies `ci-pass` for it,
builds without publication, and uploads `ade-win-release-v<VERSION>` containing:

- `ADE-<VERSION>-win-x64.exe`
- `ADE-<VERSION>-win-x64.exe.blockmap`
- `latest.yml`
- `ade-win32-x64.exe`
- `ade-win32-x64.native.tar.gz`
- `install.ps1`
- `SHA256SUMS`
- `windows-proof-manifest.json`

The generated manifest records SHA-256 and byte size for all seven indexed
release files. It also verifies that `SHA256SUMS` binds the standalone Windows
runtime, its native archive, and `install.ps1`; records the workflow run, exact
source SHA, signed-build validator gates, and SHA-256 digests of the scenario
and #999 provenance indexes. All external scenarios start as `pending`. Before
editing the manifest, record its SHA-256 and the workflow run id; publication
uses those values to retrieve and verify the immutable Actions artifact that
supplied the tested bytes.

## Proof bundle layout

Store proof outside the repository. Do not attach raw ADE databases, complete
logs, credential stores, home-directory listings, certificates, or screenshots
that expose names or account details.

```text
windows-proof-<40-character-sha>/
|-- windows-proof-manifest.json
|-- artifacts/
|   |-- ADE-<VERSION>-win-x64.exe
|   |-- ADE-<VERSION>-win-x64.exe.blockmap
|   |-- latest.yml
|   |-- ade-win32-x64.exe
|   |-- ade-win32-x64.native.tar.gz
|   |-- install.ps1
|   `-- SHA256SUMS
`-- evidence/
    |-- 0001-clean-install-win10/
    |   |-- gui-first-launch.png
    |   |-- process-supervisor.json
    |   `-- log-runtime-start.jsonl
    |-- 0002-hkcu-supervisor-recovery/
    |   |-- process-after-logon.json
    |   |-- ipc-initialize.json
    |   `-- log-recovery.jsonl
    `-- ...
```

Manifest evidence paths are relative to the `evidence/` directory and use
forward slashes. Numbered scenario directories make the evidence set skimmable;
the manifest remains the canonical index. The validator rejects absolute paths,
backslashes, empty path segments, `..` traversal, unknown manifest fields, and
evidence files over 20 MiB. GUI records accept only PNG, JPEG, or WebP; the
independent machine signals accept only bounded CSV, JSON, JSONL, log, or text
extracts. Raw SQLite databases and archives are therefore not valid evidence.
Every evidence path and content digest must be unique, so copying one extract
into several signal categories cannot satisfy the independence gate. The
validator also scans structured evidence text for obvious credentials and
personal identifiers; visual and semantic redaction still requires review.

## Exact manifest schema

`windows-proof-manifest.json` uses `schemaVersion:
"ade.windows-proof/v1"` and has these top-level fields:

| Field | Contract |
| --- | --- |
| `createdAt` | ISO timestamp for manifest creation. |
| `release` | Repository, version, tag, exact lowercase 40-character `targetSha`, `architecture: "x64"`, and non-publishing workflow identity. |
| `buildValidation` | `signedBuild: true`; canonical artifact validator; Authenticode, RFC3161 timestamp, signer-consistency, and publisher-pin gates all `passed`. |
| `artifacts` | Exactly one each of `installer`, `blockmap`, `update-manifest`, `standalone-runtime`, `standalone-native-archive`, `standalone-installer`, and `runtime-checksums`, with fixed top-level filenames, lowercase SHA-256, and positive byte size. The checksum manifest must bind the other three standalone Windows entries. |
| `indexes` | Fixed paths and SHA-256 values for `windows-full-system-scenarios.json` and `windows-source-provenance.json`. |
| `releaseGates` | Signed build enabled; non-publishing workflow true; GitHub Release creation, public Windows release, and website release readiness all false. `websiteReleaseReady` records approval state for this release, not whether a previously approved download is currently visible. |
| `approval` | `proof_pending`, `proof_complete`, or `approved`; publication readiness binds role-based approval to `approvedTargetSha`. |
| `scenarioResults` | Exactly one result for every scenario id: status, redacted host aliases, evidence ids, and optional machine-safe blocker code. |
| `evidence` | Indexed, hashed, redacted evidence records described below. |

An evidence record is exactly the reviewer-facing reference to one file:

```json
{
  "id": "proof-0042",
  "kind": "ipc",
  "collectionMethod": "initialize-probe",
  "hostAlias": "win11-lab",
  "path": "0002-hkcu-supervisor-recovery/ipc-initialize.json",
  "sha256": "<64 lowercase hexadecimal characters>",
  "sizeBytes": 1234,
  "collectedAt": "2026-08-01T13:00:00.000Z",
  "scenarioIds": ["hkcu-supervisor-recovery"],
  "redaction": {
    "status": "redacted",
    "containsSecrets": false,
    "containsPersonalIdentifiers": false
  }
}
```

`hostAlias` is a non-identifying label such as `win10-lab` or `win11-lab`.
Never use a Windows computer name, account name, email, IP address, serial
number, or device id. The validator rejects obvious token forms, email
addresses, IP addresses, and `C:\Users\<name>` paths, but collectors must still
review every file: pattern detection cannot prove that arbitrary screenshots or
free text are safe. A scenario result can link only aliases for the Windows
versions that scenario declares, and every evidence-to-scenario link must have
the matching scenario-to-evidence link.

## Independent evidence signals

The complete bundle must contain all six signal kinds, and every scenario must
link the kinds declared in
[`windows-full-system-scenarios.json`](./windows-full-system-scenarios.json).
Each scenario requires at least two independent kinds.

| Kind | What to retain | What to remove |
| --- | --- | --- |
| `gui` | Cropped screenshot of the state being asserted, with a scenario label added outside the product UI. | Account names, avatars, project paths, repository names, notification content, browser profile details. |
| `log` | Small JSONL extract containing event names, bounded status codes, timestamps, and a random proof-local correlation alias. | Raw log bundles, command arguments, paths, chat text, tokens, URLs, certificate subjects. |
| `db` | Query result containing schema/version, row counts, synthetic row aliases, and convergence values created for the test. | `.db`, WAL, SHM, real project rows, device ids, site ids, secrets. |
| `process` | Process image labels, parent/child relationship, running/stopped state, and proof-local PID aliases. | Full command lines, environment blocks, user names, installation paths, numeric PIDs reused outside the single record. |
| `ipc` | Initialize/status result, channel alias, expected capability flags, and success/denial classification. | Full named-pipe path, user-derived hash inputs, payload text, authentication material. |
| `network` | Route kind, timing, coarse outcome, proof-local correlation alias, and firewall rule classification. | IPs, hostnames, query strings, Relay URLs, pairing credentials, DPoP material, raw packets. |

GUI evidence is never accepted as the only proof of a runtime claim. A visible
"Connected" state must be paired with network, IPC, DB, process, or log evidence
from the authority that owns the operation. Similarly, a successful log line
does not prove the GUI rendered the user-visible state when a scenario requires
`gui`.

## Scenario inventory

[`windows-full-system-scenarios.json`](./windows-full-system-scenarios.json) is
the canonical inventory. Its validator-pinned `acceptanceGates` make the proof
bindings explicit rather than relying on generic shell, peer, or regression
labels. The gates cover PowerShell 5.1, PowerShell 7, cmd, Git Bash, and the full
ConPTY lifecycle; every real provider's authenticated/unauthenticated,
fresh/resume, recovery, and redaction states; standalone CLI/brain and host
lifecycle; OAuth/account directory; every cross-machine direction; transport
streaming and reconnect; signed updater identity/tamper/SmartScreen behavior;
unchanged non-Windows release paths; and the complete draft/website-disabled
contract. Removing a required gate or requirement makes inventory validation
fail. Each gate is also pinned to one exact scenario id, whose
`acceptanceRequirementIds` must enumerate every structured requirement; a
generic replacement scenario or watered-down label cannot claim the gate.

Scenario dependencies are declarations, not authorization. Account login,
certificate use, release mutation, and public-service changes must be performed
only by an authorized human or workflow. A blocked external dependency remains
`blocked`; it must never be rewritten as `pass` or omitted.

The inventory uses these gate-to-scenario bindings; the JSON index is the
authority for the complete validator-pinned requirement arrays and pass
conditions:

| Acceptance gate id | Bound scenario id | Contract boundary |
| --- | --- | --- |
| `shell-conpty-matrix` | `explicit-shell-conpty-matrix` | PowerShell 5.1, PowerShell 7, cmd, Git Bash, and the complete ConPTY lifecycle. |
| `provider-lifecycle-matrix` | `explicit-provider-lifecycle-matrix` | Every real provider in authenticated, unauthenticated, fresh, resume, recovery, and redaction states. |
| `standalone-cli-brain` | `standalone-cli-brain-lifecycle` | Standalone payload install/lifecycle/update, OpenSSH-gated remote bootstrap, and damaged-install recovery. |
| `brain-host-lifecycle` | `brain-host-lifecycle-explicit` | Desktop-closed operation, crash detection/restart, login/logout/reboot, repair, reinstall, and uninstall. |
| `account-oauth-directory` | `account-oauth-directory-explicit` | Default-browser callback, encrypted account state, reauthentication, sign-out, and existing-machine discovery. |
| `cross-machine-directions` | `cross-machine-directions-explicit` | Every required Windows/macOS/Linux/iOS/web session and client/runtime direction. |
| `transport-streaming-reconnect` | `transport-streaming-reconnect-explicit` | LAN/firewall, Tailscale, Relay, reconnect, chat/terminal streams, and remote commands. |
| `signed-updater-proof` | `signed-updater-proof-explicit` | Signed N to N+1 identity/timestamp, tamper rejection, relaunch, brain/data recovery, and SmartScreen observation. |
| `unchanged-release-paths` | `unchanged-release-paths-explicit` | Unchanged macOS desktop/runtime, Linux runtime, web, Relay, and iOS release paths. |
| `draft-assets-and-website` | `draft-assets-website-explicit` | Complete Windows artifact/update metadata and a disabled but correctly targeted website control. |

## Validation phases

From the repository root:

```powershell
node apps/desktop/scripts/windows-proof-manifest.mjs validate-inventory
node apps/desktop/scripts/windows-proof-manifest.mjs validate-provenance

node apps/desktop/scripts/windows-proof-manifest.mjs validate `
  --manifest <proof-root>\windows-proof-manifest.json `
  --phase build `
  --expected-sha <40-character-sha> `
  --artifact-root <proof-root>\artifacts
```

After every pre-tag scenario passes and its evidence is redacted and indexed, set
`approval.state` to `proof_complete` and run:

```powershell
node apps/desktop/scripts/windows-proof-manifest.mjs validate `
  --manifest <proof-root>\windows-proof-manifest.json `
  --phase complete `
  --expected-sha <40-character-sha> `
  --artifact-root <proof-root>\artifacts `
  --evidence-root <proof-root>\evidence
```

The inventory marks `draft-assets-and-website` as `stage: "post-draft"`.
`complete` and `publication-readiness` intentionally allow that one scenario to
remain `pending`, because the immutable candidate must be approved before the
tag workflow can assemble an unpublished draft. Every `pre-tag` gate must pass.

An authorized Windows release maintainer may then set only these approval
fields: `state: "approved"`, `approvedTargetSha` to the same exact release SHA,
`approverRole: "windows-release-maintainer"`, and `approvedAt`. Do not record a
person's name or account identifier. Run `--phase publication-readiness` with
both roots. This phase still requires `publicReleaseEnabled` and
`websiteReleaseReady` to be false.

After that validation succeeds, set the protected repository variables
`ADE_WINDOWS_APPROVED_PROOF_SHA`, `ADE_WINDOWS_APPROVED_PROOF_RUN_ID`, and
`ADE_WINDOWS_APPROVED_BUILD_MANIFEST_SHA256` to the exact approved source SHA,
the original non-publishing workflow run id, and the SHA-256 of the original
`proof_pending` build manifest. The public release workflow downloads that
immutable Actions artifact, verifies the manifest digest, run id, tag, exact
source SHA, and all artifact hashes, and promotes those same installer bytes.
It does not rebuild Windows with a new signing timestamp. Enabling publication
and the website remains a separate explicit maintainer action described in the
signed-release playbook.

After the tag workflow creates the unpublished draft, collect the bounded
draft-asset and disabled-website evidence, set the post-draft scenario to
`pass`, and run `--phase draft-readiness` with both roots. That phase requires
the exact role-based approval and every scenario, including the post-draft gate,
to pass. Do not publish the draft before it succeeds.

## Source provenance

[`windows-source-provenance.json`](./windows-source-provenance.json) maps all
nine commits from David Whatley's #999 head to their rebased commits and to the
semantic stack layers that derived from them. Keep this index when repartitioning
or cherry-picking the stack. The validator pins each source-to-rebased pair and
requires every source commit to appear in at least one semantic layer. Every
derived commit must preserve:

```text
Co-authored-by: David Whatley <nsxdavid@gmail.com>
Based-on: nsxdavid/ADE#999
```

The manifest stores the provenance index digest so a release proof cannot be
silently detached from the credited source mapping.

That provenance index also resolves both original #999 Codex inline P2s. The
desktop launcher reuses its current executable only when its basename exactly
matches the requested channel-qualified executable; otherwise it searches the
requested app/channel candidates. Current startup is a channel/user-qualified
HKCU Run value plus hidden PowerShell supervisor, the launcher writes the
advisory supervisor/runtime PID record, and an initialized runtime IPC response
is the separate readiness record. Any ONLOGON Scheduled Task is legacy residue
to remove, not a current service.
