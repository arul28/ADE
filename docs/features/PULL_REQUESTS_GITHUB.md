# Pull Requests (GitHub)

Last updated: 2026-02-10

## 1. Goal

Make PRs a natural extension of lanes, including stacked PR workflows.

## 2. UX Surface

- PR panel per lane (available inside Lanes tab side panel):
  - create PR
  - link existing PR
  - show checks status and review status
  - push branch
  - update PR description (drafted from packs)

- PRs tab (global):
  - stacked PR chains
  - parallel PR list for non-stacked lanes
  - “land stack” guided flow entry point

## 3. Functional Requirements

MVP:

- Push lane branch to origin.
- Create PR against base:
  - base = `main` or parent lane branch for stacked PRs
- Link PR to lane and show basic metadata.
- Draft PR description using:
  - Lane Pack deterministic sections
  - hosted narrative augmentation
- "Update PR" action:
  - push commits
  - refresh description

V1:

- Stacked PR support:
  - visualize dependencies
  - suggest review order
  - "land stack" guided flow (depends on stacks feature)
  - PR base retargeting suggestions when restacking

## 4. Safety and Auth

- Use OS keychain for tokens.
- Never store tokens in plaintext.
- Prefer official GitHub auth flows where possible.

## 5. Development Checklist

MVP:

- [ ] GitHub auth
- [ ] Push branch
- [ ] Create PR
- [ ] Link PR and show status
- [ ] Draft/update PR description from packs

V1:

- [ ] Stacked PR base retargeting
- [ ] Land stack (merge order + checks gating)
- [ ] PRs tab stacked chain view + parallel list view
