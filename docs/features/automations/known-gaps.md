# Automations: known gaps

A running ledger of automation problems found while using ADE for real work.
Each entry says what broke, how it showed up, and the workaround in use. Fix
them in a later lane; strike an entry (and name the PR) when it lands.

| # | Gap | Found | Workaround |
|---|---|---|---|
| 1 | **Linear placeholders resolve empty.** The builder's variable menu (`renderer/components/automations/variableCatalog.ts`, `LINEAR_VARS`) offers `{{trigger.issue.title}}` and friends, but Linear dispatches carry the issue under `trigger.linear.issue` (`linearAutomationDispatch.ts`). A live `linear.issue_labeled` run got `Linear issue  ("")`. | 2026-11-02, rule `linear-auto-fix-labeled` on ADE-183 | Prompts read the identifier from the "Ingress summary" line ADE prepends. |
| 2 | **Test preview leaves Linear values blank.** `ade automations test <id> --linear ADE-183 --plan` shows empty issue id and title in the prompt, so a preview cannot show what a real run gets. Likely the same root cause as #1. | 2026-11-02 | Trust a live run, not the preview. |
| 3 | **One trigger per rule.** A rule file with two `triggers` keeps only the first (`normalizeRuntimeRule` sets `triggers: [primary]`). "Created with label X" and "label X added later" need two copies of the same rule that drift apart. | 2026-11-02 | Two rules: `posthog-report-investigate` and `linear-auto-fix-labeled`. |
| 4 | **Linear triggers cannot filter on priority.** Filters are team, project, assignee and labels only. | 2026-11-02 | PostHog's destination filters on priority itself (P0–P2 become issues). It added an `auto-fix` label to P0/P1 for the rules to match until 2026-11-05; the label and both rules are off now, so no report starts an agent. |
| 5 | **Automations cannot create a Linear issue.** `linear_issue_tracker.createIssue` exists but is not in `ADE_ACTION_ALLOWLIST`, so an `ade-action` step cannot file an issue from a webhook; only an agent step can (`ade linear create`). | 2026-11-02 | PostHog files issues straight to Linear's API with a personal key. |
| 6 | **Session title templates.** `execution.session.title` with `{{trigger.*}}` is unverified for Linear triggers (see #1); the agent renamed its own chat. | 2026-11-02 | Static title `Auto-fix`; the agent renames the chat. |
