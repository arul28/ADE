import React from "react";
import { ArrowsClockwise, WarningCircle } from "@phosphor-icons/react";
import { logRendererDebugEvent } from "../../lib/debugLog";
import {
  ERROR_PRIMARY_BUTTON,
  ErrorSurfaceCard,
  TechnicalDetailsFold,
  WhatToDo,
} from "./errorSurfaceKit";
import { ReportIssueButton } from "./ReportIssueButton";

type RendererErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

const WHAT_TO_DO: readonly string[] = [
  "Reload ADE. Everything reopens where it was.",
  "If it happens again on the same screen, choose Report issue — that tells us which screen and what broke.",
];

export class RendererErrorBoundary extends React.Component<{ children: React.ReactNode }, RendererErrorBoundaryState> {
  state: RendererErrorBoundaryState = {
    hasError: false,
    message: ""
  };

  static getDerivedStateFromError(error: unknown): RendererErrorBoundaryState {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error)
    };
  }

  /**
   * One automatic report per crash, not per re-render. `componentDidCatch` is
   * React's once-per-caught-error hook (`getDerivedStateFromError` can run
   * twice under StrictMode), and this flag covers a boundary that catches again
   * after a failed recovery.
   */
  private autoReported = false;

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    if (!this.autoReported) {
      this.autoReported = true;
      // Main owns the setting and the budget; this is a request, and its answer
      // is deliberately uninteresting to a screen that is already broken.
      void window.ade?.diagnostics?.autoReport?.({
        surface: "renderer_crash",
        code: "renderer_crash",
        headline: "ADE needs to reload this window",
      }).catch(() => undefined);
    }
    // Keep renderer crashes visible in devtools logs and avoid a blank screen.
    console.error("renderer.crash", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? null : null,
      componentStack: info.componentStack,
      route: window.location.hash || window.location.pathname,
    });
    logRendererDebugEvent("renderer.root_boundary_crash", {
      message: error instanceof Error ? error.message : String(error),
      route: window.location.hash || window.location.pathname,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen overflow-y-auto bg-bg text-fg">
          {/* Min-height row rather than `items-center` on the scroller: a card
              taller than the window would otherwise be clipped at the top. */}
          <div className="flex min-h-full items-center justify-center px-6 py-10">
          <div className="w-full max-w-[520px]">
            <ErrorSurfaceCard
              icon={<WarningCircle size={18} weight="fill" aria-hidden="true" />}
              headline="ADE needs to reload this window"
              body={
                <>
                  Something went wrong while drawing the app. Your project, chats and files are
                  safe — this is only the window.
                </>
              }
            >
              <WhatToDo title="What to do" steps={WHAT_TO_DO} />

              <div className="mt-5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={ERROR_PRIMARY_BUTTON}
                  onClick={() => window.location.reload()}
                >
                  <ArrowsClockwise size={13} weight="bold" aria-hidden="true" />
                  Reload ADE
                </button>
              </div>
            </ErrorSurfaceCard>

            <div className="mt-4">
              <ReportIssueButton
                variant="secondary"
                context={{
                  surface: "renderer_crash",
                  headline: "ADE needs to reload this window",
                  technicalDetail: this.state.message || null,
                }}
              />
            </div>

            <TechnicalDetailsFold
              text={this.state.message || "No error message was recorded."}
              className="mt-4"
            />
          </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
