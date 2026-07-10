# Automations tab — UI redesign

Rebuild the `/automations` surface from a dense off-token prototype into a Linear-grade
automations builder. Local-first Electron+React+TS. Palette moves off the bespoke
`#0F0D14`/`#152235`/`#7DD3FC` blues onto the app's semantic theme tokens
(`bg-bg`, `text-fg`, `text-muted-fg`, `text-accent`, `border-border`, `bg-card`, `shadow-card`)
plus `lanes/laneDialogTokens.ts` form tokens and `lanes/laneDesignTokens.ts` `COLORS`.

## Information architecture

Two routes (both already wired in App.tsx; keep export names + `data-testid`s):

- `/automations` → `AutomationsPage` → master/detail:
  - **Left rail (list):** header (title, New, Templates, refresh) + search + ingress status strip
    + rule rows rendered as readable sentences. Empty → flagship-template pitch.
  - **Right pane:** `Builder` (default) or `History` for the selected rule, chosen by a
    segmented control in the pane header.
- `/automations/templates` → `AutomationsTemplatesPage` → grouped `TemplateGallery`.

## Component tree (all under components/automations/)

```
AutomationsPage.tsx            shell + AutomationsProductionGate (gate KEPT verbatim)
AutomationsTemplatesPage.tsx   templates route shell
AutomationsComingSoon.tsx      disabled-build screen (re-skinned to tokens)
designTokens.ts                REWRITE → semantic token class strings (input/select/label/card/section)
automationCopy.ts              rule-sentence grammar + trigger/action/disposition labels
cronDescribe.ts                cron → human gloss ("Every weekday at 9:00am") [+unit test]
triggerCatalog.ts              trigger sources → events → filter kind (incl lane.merged)
actionCatalog.ts               step kinds + add-menu data (incl delete-lane)
variableCatalog.ts             {{trigger.*}} variables grouped per trigger source
localAutomationConfig.ts       string consts for not-yet-landed types (lane.merged/delete-lane/alwaysRun)
list/
  RuleList.tsx                 left rail: header, search, ingress strip, rows, empty state
  RuleRow.tsx                  one sentence row: toggle, status glyph, next/last run, hover actions
  RuleSentence.tsx             renders trigger→steps clauses
  AutomationsEmptyState.tsx    first-visit: 3 flagship template cards
builder/
  RuleBuilder.tsx              header (Run now / Dry run / Save + status) + vertical step stack
  TriggerCard.tsx              pinned card: source picker → event → filter rows
  ScheduleEditor.tsx           cron field + live gloss + presets
  triggerFilters/*             GitHub/Linear/Git/File/Lane/Webhook filter panels (logic reused, reskinned)
  StepStack.tsx                stacked step cards + "+" inserters + terminal cleanup zone
  StepCard.tsx                 step chrome: index, label, alwaysRun badge, move/remove
  AgentStepEditor.tsx          prompt + ModelPicker + ReasoningEffortPicker + permission + lane targeting
  AdeActionEditor.tsx          moved here, reskinned (schemas data source untouched)
  RunCommandFields / RunTestsField / DeleteLaneFields
  LaneTargeting.tsx            "Run in": new lane (name template) / existing lane / no lane
  VariableMenu.tsx             {} inserter button → variable list (insert-at-cursor)
  VariableInput.tsx / VariableTextarea.tsx  input + trailing {} menu
history/
  RuleHistory.tsx              runs list + detail
  RunRow.tsx                   status glyph, duration, trigger reason
  RunDetail.tsx                per-step results, deep links (lane/chat/PR), queue/verify state
templates/
  TemplateGallery.tsx          grouped gallery + "what you'll configure"
  TemplateCard.tsx             one card
  templateData.ts              grouped templates (4 flagship + reworked existing)
settings/
  IngressStatusStrip.tsx       GitHub path (App/relay/polling) + Linear connect/status; dismissible
templates/
  TemplateSourceChip.tsx       SourceIconBadge + "Source · Event" chip, both source-accented
linearIngressApi.ts            defensive window.ade.automations.linearIngress probe (shared)
```

Kept as-is: `adeActionSchemas.ts`, `permissionControls.ts`. `shared.ts` keeps
`extractError`/`parseList`; drops the blue `INPUT_CLS` alias.

## Rule-sentence grammar

`buildRuleSentence(rule) → { trigger: string, steps: string[] }`, rendered as
`When <trigger> → <step> → <step> …` with a muted `→` between clauses.

Trigger clause (concrete, sentence case, no jargon):
- schedule → cron gloss: `Every weekday at 9:00am`
- github.issue_opened +label bug → `A GitHub issue is opened labeled bug`
- github.pr_merged base main → `A GitHub PR is merged into main`
- linear.issue_created team ENG → `A Linear issue is created in ENG`
- linear.issue_labeled → `A Linear issue is labeled`
- lane.merged pattern feature/* → `A lane matching feature/* is merged`
- git.push branch main → `A push lands on main`
- file.change paths → `A file changes in src/**`
- session-end → `An agent session ends`
- webhook → `A webhook fires`
- manual → `Run manually`

Step clause:
- new-lane execution → `create a lane`; agent-session → `run an agent`
- run-tests → `run tests`; run-command → `run a command`; predict-conflicts → `predict conflicts`
- ade-action → friendly map (pr.addComment→`comment on the PR`, issue.setLabels→`label the issue`,
  issue.close→`close the issue`, linear_sync.*→`sync Linear`) else `run {domain}.{action}`
- delete-lane / cleanup → `clean up the lane`
- disposition open-pr-draft → append `open a draft PR`

## Wireframes

Rule row (left rail):
```
┌───────────────────────────────────────────────┐
│ ● Triage new issues                    [ⁿᵉˣᵗ] ⏻│   ● = last-run glyph, ⏻ = switch
│ When a GitHub issue is opened → run an agent   │   sentence, muted, 2-line clamp
│ ✓ 2h ago · next on event         ⧗ ▶ ⋯ (hover) │   status + schedule + hover run/history/delete
└───────────────────────────────────────────────┘
```

Builder:
```
[Triage new issues]              ● enabled  ▷ Run now  ⚗ Dry run  ⌘S Save
────────────────────────────────────────────────────────────────────
┌ Trigger ─────────────────────────────────┐   pinned card
│ Source: [GitHub ▾]  Event: [Issue opened ▾]│
│ Filters: label [bug ×]  repo [owner/repo] │
└───────────────────────────────────────────┘
              +  (inserter)
┌ Step 1 · Run an agent ────────────────────┐
│ Prompt … [{}]                              │
│ Model [Sonnet ▾] Effort [MED] Perm [auto] │
│ Run in: (•) new lane  name [{{...}} {}]    │
└───────────────────────────────────────────┘
              +
┌ Cleanup (always runs) ────────────────────┐   terminal zone = trailing delete-lane+alwaysRun
│ Delete the lane  after [30] min  ☐ branch │
└───────────────────────────────────────────┘
```

## Copy deck (key strings)

- Left header: title `Automations`; buttons `New`, `Templates`; search placeholder `Search automations`.
- Empty state: `No automations yet` / `Start from a flagship, or build your own.`
- Builder header: `Run now`, `Dry run`, `Save`; unsaved dot tooltip `Unsaved changes`.
- Trigger: `Trigger`, `Source`, `Event`, `Filters`. Manual hint `Runs only when you press Run now.`
- Schedule gloss prefix: none — show gloss verbatim, e.g. `Runs every weekday at 9:00am`.
- Lane targeting: `Run in`, options `New lane each run` / `An existing lane` / `No lane`.
  New-lane name field label `Lane name`, hint `Auto-numbered if a name repeats.`
- Cleanup: `Cleanup` badge `Always runs`, `Delete the lane`, `after N minutes`, `Also delete branch`.
- Variables menu: `Insert variable`.
- Ingress strip: `GitHub events` + state (`via App` / `via relay` / `polling` / `Not receiving`);
  `Linear events` + `Connect` button / `Connected` / `last event 5m ago`.
- History: `No runs yet` / `Trigger it manually or wait for the next event.`
  Run reason line uses the trigger sentence; deep links `Open lane`, `Open thread`, `View PR`.

## Brand identity & delivery callouts

Each trigger source and each step kind carries a brand `accent` hex in `triggerCatalog.ts` /
`actionCatalog.ts` (GitHub grey, Linear indigo via `LinearMark`/`LINEAR_BRAND`, Git orange,
Lanes violet, Files/Schedule/webhook hues, agent purple, ADE-action blue, delete red). The
source picker, rule-row schedule hint, template cards/chips, ingress strip Linear row, and step
icons all tint from that accent (`sourceAccent`/`accentTint` for source tints) instead of the
single `text-accent` token — so a rule reads its source at a glance.

Delivery state is surfaced only when a path is missing, never as a green "all good" badge:
- `TriggerCard` renders a `TriggerDeliveryCallout` (amber, the delivery `setupError`, plus an
  `Open GitHub settings` / `Connect Linear` / `Open Linear settings` action) only when the
  selected source's `ingressStatus.delivery[key].ready` is false. `Connect Linear` calls
  `linearIngress.setup()` in place, then `onIngressChanged` re-fetches status.
- `RuleRow` shows a small amber warning glyph (titled with the `setupError`) when an enabled
  rule's source has no ready delivery path.
- The left-rail trust banner shows a `Trust config` CTA (calls `projectConfig.confirmTrust`)
  only when the rule list contains at least one non-`local` (shared-config) rule.

## Contracts & graceful degradation

Code against the documented contracts; guard every new IPC with optional chaining so the UI
degrades if a method is missing at runtime:
- Existing `window.ade.automations.*` (list/toggle/deleteRule/triggerManually/simulate/
  validateDraft/saveDraft/getHistory/listRuns/getRunDetail/getIngressStatus/onEvent).
- New (optional): `automations.linearIngress?.{getStatus,setup,teardown,pollNow}`,
  `automations.listScheduledCleanups?()`, `automations.cancelScheduledCleanup?(id)`.
- Not-yet-landed shared types → `localAutomationConfig.ts` string consts + `as any` at the
  draft boundary: trigger `lane.merged` (filter namePattern), action `delete-lane`
  (`laneDeleteOptions?`, `afterMinutes?`), per-action `alwaysRun?`. Builder reads/writes them
  through helpers so a later type landing is a one-line switch.

Dry run = `simulate({ draft })`. Run now = `triggerManually({ id })` (lane picker only when
lane mode requires one, existing behavior preserved).

## Preserved logic

The `AutomationRuleDraft` ⇆ built-in-actions ⇆ agent-session bridge (solo-agent collapse,
laneMode strip, legacy create-lane migration) is intricate and correct — port it verbatim into
`builder/draftBridge.ts`; only the presentation changes.
