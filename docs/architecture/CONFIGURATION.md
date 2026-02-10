# Configuration (Project, Actions, Provider Swaps)

Last updated: 2026-02-10

## 1. Goals

- Keep config readable and repo-portable.
- Avoid surprising git changes by default.
- Make provider swapping (hosted/BYOK/CLI) a config change, not a rewrite.

## 2. `.ade/` Folder

Recommended local layout (default git-ignored via `.git/info/exclude`):

- `.ade/ade.yaml` (shareable config)
- `.ade/actions.yaml` (shareable automations/actions)
- `.ade/packs/` (local-only by default)
- `.ade/transcripts/` (local-only)
- `.ade/cache/` (local-only)

## 3. Provider Swapping

Design rule:

- The local core uses a single provider interface (`ManagerProvider`).
- Config selects the default provider:
  - `hosted`
  - `byok`
  - `cli`

All providers must return the same output shapes (narratives + patch proposals).

## 4. Sync Policy

Hosted mirror sync should be configurable:

- force sync on session end
- coalesce sync during active edits
- early sync if dirty change threshold exceeded
- exclude list (denylist) for files/dirs that should never upload

