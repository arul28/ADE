# Processes and Tests

Last updated: 2026-02-10

## 1. User Value

Make "run the stack" and "run tests" consistent and fast for humans and agents.

## 2. UX Surface

- Projects (Home) tab (project-global):
  - project overview (repo, base branch, stack profile)
  - project management:
    - open/change repo (onboarding)
    - show `.ade/` state location and “open folder” escape hatch
  - managed processes list:
    - start/stop/restart
    - status + last exit code
    - readiness
    - ports
    - log viewer (filter/search)
  - test suites panel:
    - named buttons: unit/integration/e2e/custom
    - last run status per suite
  - configuration editor (UI or `.ade/` config)

## 3. Functional Requirements

MVP:

- Define process commands (argv) with cwd + env.
- Start/stop/restart processes; show stdout/stderr.
- Define test suites and run them on demand.
- Store recent run summaries (exit code, duration, failing tests if parseable).
- Provide “one button” run for a stack profile (e.g., start dev server + worker + db).

V1:

- Readiness checks (port open, log regex).
- Lane-specific overrides (ports, feature flags, env).
- "Summarize errors" using hosted agent (optional; local summary baseline).
- Detect and suggest processes/tests on onboarding (wizard).
- “Promote terminal command to managed process” flow.
- Ports panel and quick open (best-effort detection).

## 4. Integration With Packs

- Test run results should be referenced in Lane Packs.
- Process failures should appear in Lane Packs as "Known Issues" when they occur during a lane session.
- Lane Pack should include: which stack profile was used and which processes were running during the session.

## 5. Edge Cases

- Port conflicts across lanes.
- Monorepo processes running from subdirectories.
- Long-running logs and disk usage.
- Flaky readiness detection (false positives/negatives).
- Promoted processes that require interactive input.

## 6. Process/Test Detection (Onboarding Wizard)

Detection sources (best-effort, user confirms):

- `package.json` scripts (Node/TS repos)
- `Makefile` / `justfile`
- `docker-compose.yml`
- repo READMEs (optional, later)
- existing CI workflows (optional, later)

Wizard outputs:

- suggested managed processes (dev server, worker, db)
- suggested test suite buttons (unit/lint/e2e)
- suggested stack profiles (e.g., “dev”, “test”, “e2e”)

## 7. “Promote This Terminal To A Process”

When a user runs a long-lived command in a terminal (or starts a process manually), ADE should offer:

- “Promote to managed process”
- capture:
  - command argv
  - cwd
  - env overrides
  - readiness rule (optional)
  - expected ports (optional)

This is how ad-hoc workflows become reproducible buttons.

## 8. Development Checklist

MVP:

- [ ] Process runner core (start/stop, log capture)
- [ ] Log viewer (search/filter)
- [ ] Test suite definitions and run button
- [ ] Store run summaries and link to lane pack
- [ ] Stack profiles and “start all” button

V1:

- [ ] Readiness checks
- [ ] Lane overrides
- [ ] Onboarding wizard detection
- [ ] Promote terminal -> managed process
- [ ] Ports panel (best-effort)
