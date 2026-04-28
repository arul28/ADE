# Step Builders

Small factory functions that return `TourStep[]` for a specific UX beat —
e.g. "walk the user through the CreateLaneDialog" or "walk the user through
the CreatePrModal". They exist so:

1. The flagship Tutorial (`tours/firstJourneyTour.ts`) and per-tab tours
   (`tours/lanesTour.ts`, `tours/prsTour.ts`, etc.) can compose the same
   walkthrough without duplicating copy, anchors, or `beforeEnter` actions.
2. When a dialog's anchors change, there's exactly one place to update the
   tour — not N copies.

## Usage

```ts
import { buildCreateLaneDialogWalkthrough } from "../stepBuilders";

const tour: Tour = {
  id: "lanes",
  // ...
  steps: [
    { target: '[data-tour="lanes.newLane"]', title: "...", body: "..." },
    ...buildCreateLaneDialogWalkthrough(),
    { target: '[data-tour="lanes.laneTab"]', title: "...", body: "..." },
  ],
};
```

## Available builders

- `buildCreateLaneDialogWalkthrough()` — opens `lanes.create` dialog, walks
  name + branch-base + attach-existing tab + create button.
- `buildPrCreateModalWalkthrough()` — opens `prs.create` dialog, walks
  title / body / base / submit.
- `buildGitActionsPaneWalkthrough()` — walks Stage → Commit → Push on the
  `lanes.gitActionsPane` anchor. The pane's inner buttons don't yet have
  their own `data-tour` anchors; each step re-anchors on the pane with
  different copy.
- `buildManageLaneDialogWalkthrough()` — opens `lanes.manage` dialog, walks
  rename / archive / delete-scope / delete-confirm.

## Conventions

- Every step has a stable `id` prefixed with the builder name
  (`createLane.*`, `prCreate.*`, `gitActions.*`, `manageLane.*`) so the
  Tutorial and per-tab tours can branch on the same ids.
- Copy is second-person, ADE-specific, max two sentences.
- Where a step references the sample lane name, use `bodyTemplate: (ctx)`
  rather than `body` so the text adapts to `ctx.get("laneName")`.
- Every step carries a `docUrl` pulled from `../docsLinks`.
- Dialog-opening steps use `beforeEnter` returning a `openDialog` StepAction
  routed through the DialogBus — never reach into components directly.
