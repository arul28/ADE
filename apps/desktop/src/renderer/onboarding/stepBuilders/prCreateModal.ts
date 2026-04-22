import type { TourStep } from "../registry";
import { docs } from "../docsLinks";

const PR_CREATE_DIALOG_REQUIRES = ["prCreateModalOpen"] as const;
const PR_CREATE_FALLBACK_MS = 30_000;

/**
 * Reusable walkthrough for the CreatePrModal.
 * Opens the modal, walks through title / body / base / submit.
 *
 * Anchors (verified in CreatePrModal.tsx):
 *   prs.createModal.title, prs.createModal.body,
 *   prs.createModal.base, prs.createModal.submit
 */
export function buildPrCreateModalWalkthrough(): TourStep[] {
  return [
    {
      id: "prCreate.open",
      target: "",
      title: "PR dialog",
      body: "The create dialog is open. Start by choosing the source lane and target branch; title and description fields appear on the next step.",
      docUrl: docs.lanesOverview,
      requires: PR_CREATE_DIALOG_REQUIRES,
      fallbackAfterMs: PR_CREATE_FALLBACK_MS,
      fallbackNextLabel: "Continue without a PR",
      fallbackNotice: "You can continue without creating a PR.",
      beforeEnter: async () => [{ type: "openDialog", id: "prs.create" }],
    },
    {
      id: "prCreate.title",
      target: '[data-tour="prs.createModal.title"]',
      title: "PR title",
      body: "After choosing a source lane and pressing Next step, write a concise change title. ADE falls back to the lane name if you leave it empty.",
      placement: "bottom",
      requires: PR_CREATE_DIALOG_REQUIRES,
      fallbackAfterMs: PR_CREATE_FALLBACK_MS,
      fallbackNextLabel: "Continue without a PR",
      fallbackNotice: "Title appears after the modal's source and base step.",
      waitForSelector: '[data-tour="prs.createModal.title"]',
      docUrl: docs.lanesOverview,
    },
    {
      id: "prCreate.body",
      target: '[data-tour="prs.createModal.body"]',
      title: "Description",
      body: "Use the body for what changed, why, and how to test. The draft button can fill it from commits when a source lane is selected.",
      placement: "bottom",
      requires: PR_CREATE_DIALOG_REQUIRES,
      fallbackAfterMs: PR_CREATE_FALLBACK_MS,
      fallbackNextLabel: "Continue without a PR",
      fallbackNotice: "Description appears after the modal's source and base step.",
      waitForSelector: '[data-tour="prs.createModal.body"]',
      docUrl: docs.lanesOverview,
    },
    {
      id: "prCreate.base",
      target: '[data-tour="prs.createModal.base"]',
      title: "Target branch",
      body: "This field chooses where the PR will merge. It appears on the first step of the dialog after a source lane is selected.",
      placement: "top",
      requires: PR_CREATE_DIALOG_REQUIRES,
      fallbackAfterMs: PR_CREATE_FALLBACK_MS,
      fallbackNextLabel: "Continue without a PR",
      fallbackNotice: "Target branch is available once the dialog has a source lane.",
      waitForSelector: '[data-tour="prs.createModal.base"]',
      docUrl: docs.lanesStacks,
    },
    {
      id: "prCreate.submit",
      target: '[data-tour="prs.createModal.submit"]',
      title: "Create button",
      body: "Create pushes the lane and opens a PR only after the dialog is ready. If the button is disabled, finish the required fields first.",
      placement: "top",
      requires: ["prCreated"],
      fallbackAfterMs: PR_CREATE_FALLBACK_MS,
      fallbackNextLabel: "Continue without a PR",
      fallbackNotice: "The rest of the walkthrough can continue without opening a PR.",
      waitForSelector: '[data-tour="prs.createModal.submit"]',
      docUrl: docs.lanesOverview,
    },
  ];
}
