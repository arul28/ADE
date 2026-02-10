# Automations and Actions

Last updated: 2026-02-10

## 1. Goal

Allow users to wire triggers to actions so ADE stays in sync:

- packs update automatically
- conflicts are predicted promptly
- tests can run on schedule

## 2. Triggers

MVP triggers:

- terminal session end (lane-scoped)
- commit created (lane-scoped)
- schedule (project-scoped)

V1 triggers:

- base updated (fetch/pull detected)
- PR updated
- manual webhook-like trigger (from UI)

## 3. Actions

MVP actions:

- update packs (project/lane)
- sync to hosted mirror
- predict conflicts
- run tests
- run custom command

V1 actions:

- request hosted proposals for a conflict pack (still user-gated by default)
- open PR / update PR
- restack

## 4. Configuration

Actions and automations should be defined in `.ade/actions.yaml` (shareable if user opts in).

## 5. Development Checklist

MVP:

- [ ] Define `actions.yaml` schema
- [ ] Trigger engine (session end, commit, schedule)
- [ ] Action runner (packs update, tests, commands)
- [ ] UI to enable/disable and see last run status

V1:

- [ ] Richer trigger set
- [ ] Guardrails per action (propose-first, approvals)

