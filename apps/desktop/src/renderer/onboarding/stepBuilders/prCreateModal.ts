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
      title: "Open the PR dialog",
      body: "Click **Create PR**. A dialog will open with two short steps: pick what you're shipping (and where it should go), then write a title and description.",
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
      title: "Which lane to ship",
      body: "Pick the lane whose changes you want to merge into your main project. (You can only pick a lane, not your real project — that's the thing you're merging *into*.)",
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
      title: "Where it should go",
      body: "Pick which branch the changes should land on. Almost always this is your project's main branch (`main`) — ADE picks that for you by default.",
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
      title: "Onto the details",
      body: "With the lane and target picked, click **Next step**. The title and description fields appear next.",
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
      title: "Title",
      body: "A short summary of the change — like *\"Add dark mode toggle\"*. This is what reviewers see first. If you leave it empty, ADE uses the lane name.",
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
      body: "Explain the change — *what changed, why, how to try it*. Reviewers will read this. The **Draft** button writes a starter for you based on what you saved in the lane.",
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
      title: "Ship it",
      body: "Click **Create**. ADE uploads your lane to GitHub and opens the PR for you. If the button is grayed out, it means a required field is empty — fill it in and try again.",
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
