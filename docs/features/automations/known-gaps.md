# Automations: known gaps

Open automation problems found in real use: what breaks, how it shows, and the
workaround. Remove an entry when its fix lands.

| # | Gap | Workaround |
|---|---|---|
| 1 | **Linear placeholders resolve empty.** The builder's variable menu (`renderer/components/automations/variableCatalog.ts`, `LINEAR_VARS`) offers `{{trigger.issue.title}}` and friends, but Linear dispatches carry the issue under `trigger.linear.issue`. A live `linear.issue_labeled` run got `Linear issue  ("")`. | Prompts read the identifier from the "Ingress summary" line DAEX prepends. |
| 2 | **Test preview leaves Linear values blank.** `daex automations test <id> --linear <issue> --plan` shows an empty issue id and title in the prompt. Likely the same cause as #1. | Trust a live run, not the preview. |
| 3 | **One trigger per rule.** A rule with two `triggers` keeps only the first (`normalizeRuntimeRule` in `automationService.ts` sets `triggers: [primary]`). "Created with label X" and "label X added later" need two copies of one rule. | Two rules. |
| 4 | **Linear triggers cannot filter on priority.** Filters are team, project, assignee and labels only. | Filter upstream (for example, let the issue source add a label for the rule to match). |
| 5 | **Session title templates are unverified for Linear triggers** (`execution.session.title` with `{{trigger.*}}`; see #1). | A static title; the agent renames its chat. |
