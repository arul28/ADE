# Security and Privacy

Last updated: 2026-02-10

## 1. Defaults

- Local core is the only component that mutates files and runs git operations.
- Hosted agent is read-only and returns proposals/artifacts.
- Tests run locally only.

## 2. Secrets and Excludes

Even when "hosted agent can read the whole repo" is enabled, ADE should:

- exclude obvious secret files by default (`.env*`, keys, certs)
- exclude build outputs and dependencies
- allow per-project overrides

## 3. Hosted Mirror Considerations

To support a read-only mirror:

- store encrypted at rest
- strict tenant isolation (project-level)
- audit logs for sync and agent reads
- explicit retention policy and user controls

## 4. Terminal Transcripts

Terminal transcripts can contain secrets. Default posture:

- store transcripts locally
- do not upload transcripts unless explicitly enabled
- redact obvious patterns if transcript upload is enabled

## 5. Safety Contract for Proposals

- Patches are always shown as diffs before applying (default).
- Applying a patch creates an operation record and undo point.
- Auto-apply (if ever enabled) must be per-action opt-in and test-gated.

