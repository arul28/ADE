# Tab parity scope

Mission-specific scope guidance for ADE iOS parity work.

**What belongs here:** per-tab scope decisions, desktop-to-mobile adaptation rules, and boundaries that workers should preserve.

---

## Lanes
- Lanes is the benchmark tab for mobile quality
- Preserve its breadth: lane scanning, detail, git actions, diffs, create/manage/attach, stack visibility
- Use it as the reference for explicit state handling, card hierarchy, and shared component promotion

## Work
- Highest-priority weak tab
- Scope is chat + sessions + terminal-related work only
- Do not create separate CTO or Missions product surfaces in this mission
- Must become mobile-first and readable on iPhone while keeping parity with the desktop Work value that the existing iOS tab can realistically support

## Files
- Locked to read-only mobile parity
- Focus on workspace switching, tree browsing, quick open, text search, file preview, metadata, diff, and history/fallback
- Do not add unrestricted mobile editing or desktop Monaco parity

## PRs
- Focus on mobile list/detail/workflow parity for the existing PR tab
- Includes stack visibility plus queue/integration/rebase cards already belonging to PRs
- Adapt desktop density to mobile instead of reproducing wide desktop layouts literally

## Settings
- Core mobile settings only
- Keep the shell centered on sync/pairing, appearance, host status, and any small mobile-relevant preferences shipped by this mission
- Do not broaden into full desktop settings/admin parity unless the orchestrator changes scope

## Cross-tab expectations
- Preserve source-tab context when navigating away and back
- Keep disconnected recovery paths flowing through `Settings`
- Use consistent glass/action language across the five tabs
- Backend/shared contract work is allowed when parity requires it, but only for the existing iOS tabs in scope
