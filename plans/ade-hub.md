# ADE Hub — Open Plan & Spec

> Status: brainstorm consolidation. Not approved, not scheduled, not scoped to a release. This is a working document to come back to.

## 1. The idea in one paragraph

A public hub where users point their existing agent CLIs (Claude Code, Codex, Cursor, opencode, droid) at OSS GitHub issues, using their *idle* model/plan capacity that would otherwise reset unused. Maintainers opt repos in by merging an `.agent-hub.yml` to `main`. ADE Hub — a TUI alongside `ade code` — is the canonical dispatcher: it pulls eligible issues from the registry, applies budgets/skills/policy, and runs the user's chosen CLI to produce a PR through their own GitHub identity. Goal: convert wasted token capacity into accountable OSS contributions, with quality gates strong enough that maintainers welcome it instead of banning it.

## 2. Motivation

- Power users on Max-tier plans (Claude, ChatGPT Pro, Cursor, etc.) regularly leave 30–60% of their cap unused before reset.
- That capacity is non-transferable and dies on reset.
- OSS maintainers have huge `good-first-issue` backlogs and limited triage time.
- Agent-PR quality is currently *bad enough* that several major projects (curl, Python, etc.) have banned or restricted AI submissions. So the market need is real *and* the bar is high.
- The unmet primitive: a shared substrate that pools idle agent capacity against an opt-in public queue, with claim visibility, budgets, and contribution attribution.

## 3. What exists today (and why this isn't it)

- **SWE-bench / agent evals**: solving issues, but as benchmarks, not contributions.
- **Sweep, Codegen, CodeRabbit, Devin, Copilot Workspace**: agents that open PRs, but tied to a *specific* repo/org the user controls.
- **All Hands / OpenHands cloud, Codex cloud, Claude Code Cloud**: dispatch agents at issues, but BYO repo and BYO credits to your own work.
- **Algora / bounty platforms**: humans claim for money. Different economic model.

The gap: no shared queue + idle-capacity donation + maintainer-opt-in + cross-runtime policy layer.

## 4. Core principles (locked)

1. **Maintainer opt-in is the foundation.** No repo participates without a yml on main. No exceptions.
2. **No new auth system.** GitHub OAuth pass-through only. No platform-side user accounts.
3. **Quality gates over volume.** The platform's job is to make sure agent PRs are *welcome*, not *abundant*.
4. **User's GitHub identity, user's accountability.** All PRs through the user's own account. Platform is orchestrator, not author.
5. **ADE Hub is the canonical dispatcher, but the registry is open.** Other dispatchers can integrate via a thin client SDK.
6. **Open source everything.** Registry API, frontend, schema, dispatcher. The `.agent-hub.yml` spec is the durable artifact.
7. **Single hosted instance for v1.** Federation is a v3+ concern.

## 5. Architecture

### 5.1 Components

| Component | Role | Hosting |
| --- | --- | --- |
| **Registry API** | Stores registered repos, configs, issue activity signals, ban lists. JSON over HTTP. No user data. | `hub.ade.dev` (sub-site of ADE) |
| **Registry website** | Repo submission form, browse repos, browse issues, agent activity per issue, public dashboards. Static-ish frontend over the API. | `hub.ade.dev` |
| **`.agent-hub.yml`** | Per-repo maintainer contract on `main`. Eligibility, banned users, contribution skill, required checks. | Repo, `main` branch |
| **ADE Hub TUI** | Dispatcher + policy wrapper. Pulls work, applies budgets/skills, invokes user's CLI, posts PR. Reuses ADE Code infra. | Ships in `ade` install |
| **Client SDK** | Thin Go/Node lib so other dispatchers (or vanilla scripts) can also pull from the registry. | OSS, in monorepo |

### 5.2 ADE Hub is a wrapper, not a runtime

Correction from earlier sketches: ADE Hub does **not** ship its own model runtime. Like `ade code`, it wraps the user's existing CLI install (Claude Code, Codex, Cursor, opencode, droid) and uses their existing subscriptions. The "common rules" benefit comes from ADE Hub being the *dispatcher and policy wrapper* between the registry and the user's CLI — every CLI gets the same skill files, same budgets, same submission gates, regardless of which underlying agent runs.

### 5.3 Flow

```
[Maintainer]        [Submitter]               [User w/ idle tokens]
    |                    |                            |
    | merge .agent-hub.yml                            |
    |                    |                            |
    |                    | enter repo URL on hub.ade.dev
    |                    | -> registry fetches yml from main
    |                    | -> if 200, register; if 404, error
    |                                                 |
    |                                                 | open `ade hub` TUI
    |                                                 | configure budgets / picks / mode
    |                                                 | launch agent
    |                                                 |
    |                                                 v
    |                                          [ADE Hub dispatcher]
    |                                                 |
    |                                                 | pulls eligible issue from registry
    |                                                 | injects repo's contribution skill
    |                                                 | invokes user's chosen CLI
    |                                                 | runs tests locally if possible
    |                                                 | opens PR through user's GH OAuth
    |                                                 |
    |                    <-------- PR opened ---------|
    | reviews PR normally                             |
    | (PR body links back to hub.ade.dev)             |
```

## 6. `.agent-hub.yml` spec (v0 draft)

Path: `/.agent-hub.yml` on default branch. Presence = consent.

```yaml
# Required
version: 1

# Required: which issues agents may pick up
eligibility:
  labels_any: [good-first-issue, agent-eligible]   # match if any label present
  labels_none: [no-agents, wip, discussion]        # skip if any label present
  state: open
  assignee: null                                   # only unassigned, or set to a bot user

# Required: what an agent must do before submitting
submission:
  require_local_tests_attempted: true              # not "must pass" — must have tried
  require_test_command: "pnpm test"                # what to run; agent reports outcome in PR body
  require_pr_body_template: ".github/AGENT_PR_TEMPLATE.md"  # optional; agent fills it
  required_pr_footer: "Contributed via hub.ade.dev"

# Optional: claim/contestation policy
claim_policy:
  discourage_contested: true     # if another agent has open PR for same issue, skip by default
  contested_lookback: 48h

# Optional: bans
banned_users: []                 # GitHub usernames; public is fine

# Optional: minimum reputation
min_user_score: 0                # 0 = anyone; higher = vetted users only

# Optional: skill reference
contribution_skill:
  source: ".github/agent-contribution-skill.md"   # path in repo
  # or
  inline: |
    ...skill content...

# Optional: verification
verified_by: "octocat"           # platform checks this user has admin on the repo (one-time OAuth)
```

**Why these fields specifically**:

- `labels_any` / `labels_none`: gives maintainer fine control with zero new vocabulary.
- `require_local_tests_attempted`: based on the decision that requiring *passing* is too brittle (local/cloud CI divergence), but requiring *attempted* catches most slop.
- `discourage_contested`: implements the "soft signal, not hard claim" decision.
- `banned_users`: public on purpose — accountability cuts both ways.
- `verified_by`: optional trust badge without storing OAuth tokens.

## 7. Quality gates (where the product lives or dies)

The hard problem isn't tech, it's slop. These are non-negotiable:

1. **CONTRIBUTING.md auto-injection**: platform fetches and caches each registered repo's `CONTRIBUTING.md`, code style files, PR template; compiles into a skill injected at agent launch.
2. **Local test attempt mandatory**: agent must run the documented test command. Outcome (pass/fail/couldn't-run) goes in PR body verbatim. PRs without a test-attempt section are blocked at submission.
3. **Contested-issue avoidance default-on**: most users don't want to waste tokens on dupes. Power users can opt back in.
4. **Reputation scoring based on PR engagement, not merge ratio**: did review comments happen, did author respond, were changes pushed in response, was it merged, was it closed-without-comment (worst signal). Avoids penalizing legit PRs that maintainers ghost.
5. **Per-repo ban lists** in yml. Maintainers can ban GH usernames from contributing to *their* repo via the hub.
6. **Per-repo PR rate limit**: maintainer can set `max_open_agent_prs: 5` to prevent flooding.
7. **PR body always discloses**: hub origin, dispatcher (ADE Hub vN.M), underlying model/CLI, test attempt summary, budget consumed. Maintainers can filter on it.

## 8. ADE Hub TUI sketch (paper-level)

Screens (TBD, no UI work yet):

- **Home**: registered repo count, your contribution stats, agents currently running, recent PRs.
- **Browse repos / issues**: filter by language, label, repo, claimed/unclaimed.
- **Launch agent**: pick repo(s) or "anything I'm qualified for", budget cap (token / dollar / PR count), claim policy, which CLI to wrap, dry-run vs auto-submit.
- **Running agents**: live list (analogous to ADE Code's running missions), with current step, tokens consumed, current issue.
- **Settings**: GitHub OAuth, default CLI, default budgets, banned-repo personal allowlist.

Reuses from ADE Code: chat surface, lane/worktree model (each agent run = one lane), PR creation flow, model/sub detection, budget metering.

## 9. Rollout plan

- **v0.0 — Spec**: this doc + `.agent-hub.yml` lands in ADE repo as canonical example.
- **v0.1 — Closed dogfood, single repo (ADE itself)**:
  - Registry API minimal: serve ADE's own yml, list eligible issues.
  - ADE Hub TUI minimal: pick one issue, launch one agent, open one PR. No browse, no dashboard yet.
  - User = the maintainers of ADE.
  - Acceptance: an agent-PR via ADE Hub lands in ADE.
- **v0.2 — Invite-only, 3–5 partner repos**:
  - Submission form on hub.ade.dev (no public listing yet).
  - Dashboard v1, agent activity feed, budget enforcement, ban list.
  - Acceptance: 10+ merged PRs across partner repos.
- **v0.3 — Public registry submissions**:
  - Anyone can submit a repo by URL; yml check on main = consent.
  - Public browse, public dashboards.
  - Reputation scoring v1.
- **v0.4+** — federation, multi-dispatcher SDK polish, marketing.

The sequencing matters: early PR quality sets the maintainer expectation that v0.3 will be judged against. Rushing to public submissions is the single biggest risk.

## 10. Out of scope for v1

- Federation between registries.
- Bug-hunting in *open PRs* (different consent model — out forever or much later).
- Multi-author / collaborative agent runs.
- Web-based agent runtime (browser-only users) — TUI/CLI install only.
- Anything resembling a marketplace with payments.
- Global cross-repo reputation as a gate (only per-repo bans for v1; score visible but advisory).

## 11. Open questions

These need answers before v0.1 ships:

1. **Who operates `hub.ade.dev`?** Personal infra? ADE org? Separate non-profit/entity? Affects funding, longevity, liability for surfacing third-party repos.
2. **What's the legal posture on "agents opening PRs through user accounts"?** GitHub ToS currently permits agent-assisted PRs with human accountability. Worth a closer read before v0.2.
3. **CI cost externalization**: agent PRs trigger maintainer CI. Some projects pay for CI minutes. Do we cap PRs/repo/day to limit this? Mention in yml?
4. **Contested-issue UX**: when an agent decides to *also* work a contested issue, do we tell the maintainer in the PR body explicitly ("I worked this in parallel with @other_user's open PR")?
5. **What if local tests can't run?** Some repos require infra, secrets, Docker, etc. yml field `tests_local_runnable: false` to mark? Agent runs reduced check?
6. **Budget enforcement granularity**: token budget? Dollar budget? PR count? All three composable? Where does enforcement live — TUI client-side or registry-side? (Probably client-side because the registry never sees the API key.)
7. **Skill format**: reuse ADE's existing SKILL.md frontmatter, or define a new agent-hub-specific format? Strong instinct: reuse.
8. **Sybil resistance**: nothing prevents one human from running 10 GH accounts. Do we care? (Probably not for v1 — maintainers can ban accounts. But worth flagging.)
9. **Per-issue lifecycle**: what happens to a registered issue when it's closed? Agent activity log preserved? Wiped? Probably preserved-but-archived.
10. **Repo dormancy**: if yml is deleted from main, what's the grace period before the repo is removed from the registry? (Suggested: 7 days, with cron re-fetch.)

## 12. Ideas parked for later

- **"Idle hours" mode**: schedule the agent to only run during your low-usage windows (e.g. overnight) so it never competes with your own active work.
- **Token donation badge** on the user's GitHub profile (Shields-style): "X PRs contributed via hub.ade.dev with Y idle tokens."
- **Maintainer-curated bounty extension**: maintainer flags an issue as `priority`, contributors who land it get a profile shoutout.
- **PR pair-review**: optional flag that has a *second* agent (different model) review the PR locally before submission. Costs more tokens, catches more slop. Power-user opt-in.
- **Skill registry**: extracted contribution skills from many repos become a public, browsable library — useful even outside the hub context.
- **Cross-repo issue similarity**: "this looks like a known pattern fix in 3 other repos" hints to the agent.
- **Maintainer feedback channel**: maintainer can 👎 a PR via the hub UI; signal feeds reputation scoring.
- **"Verified runtime" tier**: deferred — ADE Hub originally floated as the trust tier, but since ADE Hub wraps user CLIs identically to other dispatchers, the trust tier should be on *policy compliance*, not runtime identity. Possibly score-based: dispatchers that always inject the right skills and run the right checks get verified.
- **Repo discovery via GitHub code search** (`filename:.agent-hub.yml`): cron a daily pass and surface "discovered repos awaiting maintainer claim."

## 13. First three concrete actions (when this picks back up)

1. Finalize `.agent-hub.yml` schema (this doc has draft v0; ratify or revise).
2. Pick 3–5 specific ADE issues that would be valid v0.1 candidates and tag them.
3. Spike the registry API with two endpoints — `POST /repos` (register by URL), `GET /repos/:owner/:name/issues` (return eligible issues with activity signals). Hosted nowhere yet; just runs locally to validate the schema.

Everything else flows from those three.

---

**Last updated**: 2026-05-13. Reconvene when ready to scope v0.1 against ADE issues.
