# Automations tab: UI

The `/automations` surface is a master/detail builder on the app's semantic
theme tokens (`bg-bg`, `text-fg`, `text-muted-fg`, `text-accent`,
`border-border`, `bg-card`) plus the lane form tokens
(`lanes/laneDialogTokens.ts`, `lanes/laneDesignTokens.ts`). Files are under
`apps/desktop/src/renderer/components/automations/`.

## Layout

- `/automations` → `AutomationsPage` → `AutomationsWorkspace`:
  - **Left rail:** header (title, New, Templates, refresh), search, ingress
    strip, rule rows as sentences. Empty → flagship template cards.
  - **Right pane:** Builder (default) or History for the selected rule, by a
    segmented control.
- `/automations/templates` is a view of the same page (`templatesOpen` in
  `AutomationsPage.tsx`) showing `templates/TemplateGallery`.
- On a DAEX Cloud tab the page shows the read-only `AutomationsAccountList`.

## Component map

```
AutomationsPage.tsx            shell + AutomationsProductionGate, templates view, cloud list
AutomationsWorkspace.tsx       master/detail, draft restore, newer-version banners
AutomationsAccountList.tsx     read-only list from the account (no computer awake)
AutomationsComingSoon.tsx      disabled-build screen
designTokens.ts                semantic token class strings
automationCopy.ts              rule-sentence grammar, trigger/action/disposition labels
cronDescribe.ts                cron → human gloss
triggerCatalog.ts              sources → events → filter kinds; per-source accent
actionCatalog.ts               step kinds + add-menu; per-step accent
variableCatalog.ts             {{trigger.*}} variables per source
localAutomationConfig.ts       lane.merged / delete-lane / alwaysRun constants and readers
ruleSync.ts                    account-sync lines (ruleSyncLine, ruleElsewhereReason)
automationDraftStore.ts        unsaved draft per repository in local storage
automationFeatureGate.ts       what the rule's machine can run
GitHubTriggerFilters.tsx, LinearTriggerFilters.tsx, RulePermissionPicker.tsx
AdeActionEditor.tsx, adeActionSchemas.ts   DAEX action step editor and its schemas
WebhookOverview.tsx, webhookSurface.ts, notifyLink.ts
list/      RuleList, RuleRow, RuleSentence, AutomationsEmptyState
builder/   RuleBuilder, TriggerCard, ScheduleEditor, StepStack, StepCard,
           AgentStepEditor, NotifyStepEditor, MinutesInput, LaneTargeting,
           ChatTargetField, RuleMachineField, RuleCloudField, VariableMenu,
           TestRunControls, WebhookTriggerPanel, WebhookDeliveries, draftBridge
history/   RuleHistory, RunRow, RunDetail, runPresentation, testRunInfo
templates/ TemplateGallery, TemplateCard, TemplateSourceChip, templateData, templateIcons
settings/  IngressStatusStrip
```

`builder/draftBridge.ts` is the `AutomationRuleDraft` ⇆ built-in actions ⇆
agent-session bridge (solo-agent collapse, lane-mode strip, legacy create-lane
migration). It is intricate; change it with care.

Template prompts (`templates/templateData.ts`) name the CLI through
`BRAND.CLI` (`daex prs checks`, `daex prs comments`, `daex prs create`, …) and
the `daex-*` skill names; old saved prompts that say `ade` or `ade-*` still
work through the aliases.

## Rule-sentence grammar

`buildRuleSentence(rule) → { trigger, steps[] }`, rendered as `When <trigger>
→ <step> → …`.

Trigger clauses: schedule → cron gloss (`Every weekday at 9:00am`);
`github.issue_opened` + label → `A GitHub issue is opened labeled bug`;
`github.pr_merged` + base → `A GitHub PR is merged into main`;
`linear.issue_created` + team → `A Linear issue is created in ENG`;
`lane.merged` + pattern → `A lane matching feature/* is merged`; `git.push` →
`A push lands on main`; `file.change` → `A file changes in src/**`;
`session-end` → `An agent session ends`; `session.limit_reached` / `.failed` /
`.ended_without_pr` use `sessionSubject` (`This chat` for a chat-scoped rule,
else the provider filter, else every session); `webhook` → `A webhook fires`;
`manual` → `Run manually`.

Step clauses: new lane → `create a lane`; agent-session → `run an agent`;
`run-tests`, `run-command`, `predict-conflicts`; `ade-action` → a friendly map
(`pr.addComment` → `comment on the PR`, …) else `run {domain}.{action}`;
`delete-lane` → `clean up the lane`; `handoff` → `hand off to <model display
name>`; `open-pr-draft` disposition → `open a draft PR`.

## Brand accents and delivery callouts

Each trigger source and step kind has an `accent` hex in `triggerCatalog.ts` /
`actionCatalog.ts`; the source picker, row schedule hint, template cards,
ingress strip and step icons tint from it (`sourceAccent`, `accentTint`).

Delivery state shows only when a path is missing: `TriggerCard` renders an amber
`TriggerDeliveryCallout` (the `setupError` plus Open GitHub settings / Connect
Linear / Open Linear settings) when `ingressStatus.delivery[key].ready` is
false; `RuleRow` shows an amber glyph for an enabled rule with no ready path.

## Drafts and capabilities

The unsaved draft is kept in local storage per repository tab id
(`automationDraftStore.ts`) with its "Runs on" choice, restored with a banner
(Discard). Save and Discard clear it. It never syncs. Writes are throttled
(300 ms) and flushed on unload. The stored draft names its rule and machine by
id; a window removes it only when it wrote or restored it. A run link
(`/automations?rule=&run=`) shows first, and the draft comes back after.

`automations.getCapabilities` on the rule's machine (cached per machine and
brain version) says which triggers, step types, lane modes, DAEX actions and
DAEX Cloud lanes it supports. Older brains are judged by
`shared/automationFeatureVersions.ts` against the brain's version. Missing
features are greyed out with "Needs DAEX X on <machine>"; Save on a draft that
uses one asks "<machine> can't run this rule yet." with **Save anyway**. A
`null` or failed answer is asked again every 15 s, up to 4 times. The brain also
refuses an uncallable DAEX action step in `validateDraft` / `saveDraft`
(`action_not_callable`).

## Where a rule lives

From `ruleSync.ts`, shown once per place:

- **Row:** a cloud glyph for a synced rule (with the home's name only when this
  window can't reach it); an amber glyph for a rule kept on this computer for a
  reason (too large, signed out, another account, no remote); an amber glyph by
  the title for a rule made with a newer DAEX (toggle off). Run now and History
  are disabled with the reason when the rule runs elsewhere.
- **Runs on:** an unreachable home reads "<name> (not connected to this
  window)". One line under it: "Synced · runs only on this computer", "Moving
  here · starts by <time>", "Paused here · can't reach your DAEX account", or
  the kept-here reason. Moving a synced rule says the new home starts it
  `AUTOMATION_HOME_HANDOVER_MINUTES` (12) minutes after saving.
- **Banners:** "Made with a newer DAEX" (Save, Test and Run now disabled) and
  "This computer is missing something this automation needs" listing each gap.

## Copy

- Header: `Automations`, `New`, `Templates`; search `Search automations`.
- Empty: `No automations yet` / `Start from a flagship, or build your own.`
- Builder: `Run now`, `Test`, `Save`; Test menu `Preview` / `Safe test` / `Live test`.
- Lane targeting: `Run in`: `New lane each run` / `An existing lane` / `No lane`.
- Cleanup: `Always runs`, `Delete the lane`, `after N minutes`, `Also delete branch`.
- Ingress strip: `GitHub events` (`via App` / `via relay` / `polling` / `Not
  receiving`); `Linear events` (`Connect` / `Connected` / `last event 5m ago`).
- History: `No runs yet`; badges `Safe test` / `Live test`; `Clean up the lane`.
