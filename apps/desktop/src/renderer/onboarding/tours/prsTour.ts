import { registerTour, type Tour } from "../registry";
import { docs } from "../docsLinks";

// Standalone PRs walkthrough. Replayable from the ? menu.
// Switches the detail drawer's tabs in-flight via `ade:tour-pr-detail-tab`
// (handler in PrDetailPane.tsx). Each detail-tab step has a comma-fallback to
// `prs.detailDrawer` so it spotlights a sensible area when no PR is selected.
const FALLBACK_MS = 12_000;

export const prsTour: Tour = {
  id: "prs",
  title: "PRs walkthrough",
  route: "/prs",
  steps: [
    {
      target: '[data-tour="prs.list"]',
      title: "Your PR list",
      body: "A **PR** (Pull Request) is how you say *\"please pull this lane's changes into the main project\"* on GitHub. This list shows all the PRs for your project. Click any one to see its details on the right.",
      docUrl: docs.prsOverview,
      placement: "right",
    },
    {
      target: '[data-tour="prs.createBtn"]',
      title: "Open a new PR",
      body: "When you've got changes in a lane you want to ship, click here. A two-step dialog asks you which lane to ship and what to call the change — ADE handles the rest.",
      docUrl: docs.prsOverview,
      placement: "bottom",
    },
    {
      target: '[data-tour="prs.detailDrawer"], [data-tour="prs.list"]',
      title: "Inside a PR",
      body: "When you click a PR, this panel opens with four tabs: **Overview** (the basics), **Files** (what changed), **CI / Checks** (automated tests), **Activity** (review comments). Pick a PR row to follow along.",
      docUrl: docs.prsOverview,
      placement: "left",
      fallbackAfterMs: FALLBACK_MS,
      fallbackNextLabel: "Skip drawer",
      fallbackNotice: "Nothing's broken — this panel just stays empty until you click a PR.",
    },
    {
      target: '[data-tour="prs.checksPanel"], [data-tour="prs.detailDrawer"]',
      title: "Automated tests",
      body: "Live results from automated tests that run every time you push code (this is called **CI**). Click any row to read the full output without bouncing over to GitHub.",
      docUrl: docs.prsOverview,
      placement: "left",
      beforeEnter: async () => [{
        type: "ipc",
        call: async () => {
          window.dispatchEvent(new CustomEvent("ade:tour-pr-detail-tab", { detail: "checks" }));
        },
      }],
      fallbackAfterMs: FALLBACK_MS,
      fallbackNextLabel: "Skip Checks",
      fallbackNotice: "Tests show up once a PR is selected.",
    },
    {
      target: '[data-tour="prs.stackingIndicator"], [data-tour="prs.detailDrawer"]',
      title: "Stacked PRs",
      body: "When you split a big change into smaller PRs that build on each other, this badge shows where this one sits in the stack. Standalone PRs don't show this.",
      docUrl: docs.lanesStacks,
      placement: "left",
      fallbackAfterMs: FALLBACK_MS,
      fallbackNextLabel: "Skip stacking",
      fallbackNotice: "Stacking only shows for PRs that build on top of another PR.",
    },
    {
      target: '[data-tour="prs.closeBtn"], [data-tour="prs.detailDrawer"]',
      title: "Closing the PR",
      body: "When the work is shipped (or you've decided to drop it), close it from here. The lane stays around in case you want to keep working on it.",
      docUrl: docs.prsOverview,
      placement: "top",
      fallbackAfterMs: FALLBACK_MS,
      fallbackNextLabel: "Skip close",
      fallbackNotice: "Close is only available for open, non-merged PRs.",
    },
  ],
};

registerTour(prsTour);

export default prsTour;
