import type { TourStep } from "../registry";
import { docs } from "../docsLinks";

const PR_CREATE_DIALOG_REQUIRES = ["prCreateModalOpen"] as const;
const PR_CREATE_FALLBACK_MS = 30_000;
const PR_CREATE_DIALOG_SELECTOR = '[data-tour="prs.createModal"]';

/**
 * Reusable walkthrough for the CreatePrModal.
 * Walks through the visible PR create button and the modal's two-step flow.
 *
 * Anchors (verified in CreatePrModal.tsx):
 *   prs.createBtn, prs.createModal.source, prs.createModal.base,
 *   prs.createModal.next, prs.createModal.title, prs.createModal.body,
 *   prs.createModal.submit
 */
export function buildPrCreateModalWalkthrough(): TourStep[] {
  return [
    {
      id: "prCreate.open",
      target: '[data-tour="prs.createBtn"]',
      title: "Create a PR",
      body: "Click Create PR to open the PR dialog. It starts with source and target branches, then moves to title and description.",
      placement: "bottom",
      docUrl: docs.lanesOverview,
      waitForSelector: '[data-tour="prs.createBtn"]',
      awaitingActionLabel: "Waiting for Create PR",
      advanceWhenSelector: '[data-tour="prs.createModal.source"]',
      exitOnOutsideInteraction: true,
    },
    {
      id: "prCreate.source",
      target: '[data-tour="prs.createModal.source"]',
      title: "Source lane",
      body: "Choose the lane you want to ship. Only non-primary lanes can be PR sources.",
      placement: "right",
      requires: PR_CREATE_DIALOG_REQUIRES,
      fallbackAfterMs: PR_CREATE_FALLBACK_MS,
      fallbackNextLabel: "Continue without a PR",
      fallbackNotice: "You can continue without creating a PR.",
      waitForSelector: '[data-tour="prs.createModal.source"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [PR_CREATE_DIALOG_SELECTOR],
      docUrl: docs.lanesOverview,
    },
    {
      id: "prCreate.base",
      target: '[data-tour="prs.createModal.base"]',
      title: "Target branch",
      body: "This field chooses where the PR will merge. ADE defaults it from the primary lane.",
      placement: "top",
      requires: PR_CREATE_DIALOG_REQUIRES,
      fallbackAfterMs: PR_CREATE_FALLBACK_MS,
      fallbackNextLabel: "Continue without a PR",
      fallbackNotice: "Target branch is available once the dialog has a source lane.",
      waitForSelector: '[data-tour="prs.createModal.base"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [PR_CREATE_DIALOG_SELECTOR],
      docUrl: docs.lanesOverview,
    },
    {
      id: "prCreate.next",
      target: '[data-tour="prs.createModal.next"]',
      title: "Move to details",
      body: "Click Next step after the source and target are set. The title and description fields appear on the next screen.",
      placement: "left",
      requires: PR_CREATE_DIALOG_REQUIRES,
      fallbackAfterMs: PR_CREATE_FALLBACK_MS,
      fallbackNextLabel: "Continue without a PR",
      fallbackNotice: "You can continue without creating a PR.",
      waitForSelector: '[data-tour="prs.createModal.next"]',
      awaitingActionLabel: "Waiting for PR details",
      advanceWhenSelector: '[data-tour="prs.createModal.title"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [PR_CREATE_DIALOG_SELECTOR],
      docUrl: docs.lanesOverview,
    },
    {
      id: "prCreate.title",
      target: '[data-tour="prs.createModal.title"]',
      title: "PR title",
      body: "Write a concise change title. ADE falls back to the lane name if you leave it empty.",
      placement: "bottom",
      requires: PR_CREATE_DIALOG_REQUIRES,
      fallbackAfterMs: PR_CREATE_FALLBACK_MS,
      fallbackNextLabel: "Continue without a PR",
      fallbackNotice: "Title appears after the modal's source and base step.",
      waitForSelector: '[data-tour="prs.createModal.title"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [PR_CREATE_DIALOG_SELECTOR],
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
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [PR_CREATE_DIALOG_SELECTOR],
      docUrl: docs.lanesOverview,
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
      awaitingActionLabel: "Waiting for PR",
      advanceWhenSelector: '[data-tour="prs.listRow"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [PR_CREATE_DIALOG_SELECTOR],
      docUrl: docs.lanesOverview,
    },
  ];
}
