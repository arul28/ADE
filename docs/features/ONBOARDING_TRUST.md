# Onboarding and Trust

Last updated: 2026-02-10

## 1. Goal

Make users comfortable letting ADE operate on their repos by:

- being transparent about actions
- being reversible by default
- never surprising users with silent commits or repo changes

## 2. Onboarding Flow (MVP)

1. Select a repo folder.
2. ADE detects:
   - default base branch
   - existing run/test commands (best-effort)
3. ADE creates `.ade/` local state (git-ignored via `.git/info/exclude` by default).
4. ADE offers to connect hosted agent:
   - explains what gets synced (with exclude list)
   - shows retention and read-only constraints
5. Create first lane and start first terminal session.

## 3. Trust Surfaces

- "What ADE will do" preview on:
  - sync lane
  - restack
  - applying a proposal
  - archiving a lane
- Operation timeline:
  - every operation recorded with pre/post SHAs
  - undo is always available when possible
- Escape hatches:
  - open worktree folder in OS
  - open external terminal
  - open external editor

## 4. Development Checklist

MVP:

- [ ] Safe-start onboarding wizard
- [ ] `.git/info/exclude` default setup
- [ ] Hosted agent consent screen (sync + excludes)
- [ ] Operation timeline viewer

V1:

- [ ] Lane repair tools
- [ ] Better error explanations and recovery flows

