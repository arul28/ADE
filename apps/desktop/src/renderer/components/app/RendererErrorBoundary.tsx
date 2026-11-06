import React from "react";
import { ArrowsClockwise, WarningCircle } from "@phosphor-icons/react";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { captureError, confirmSentryDelivery } from "../../../shared/sentry/capture";
import {
  ERROR_PRIMARY_BUTTON,
  ErrorSurfaceCard,
  TechnicalDetailsFold,
} from "./errorSurfaceKit";
import { ReportIssueFooter } from "./ReportIssueFooter";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { reloadForStaleChunk } from "../../lib/staleChunkReload";

const RENDERER_CRASH_HEADLINE = "ADE needs to reload this window";

type RendererErrorBoundaryState = {
  hasError: boolean;
  message: string;
  /** This crash's Sentry event, once captured. */
  crashEventId: string | null;
  /** Sentry confirmed it has this crash. */
  errorReportReceived: boolean;
};

export class RendererErrorBoundary extends React.Component<{ children: React.ReactNode }, RendererErrorBoundaryState> {
  state: RendererErrorBoundaryState = {
    hasError: false,
    message: "",
    crashEventId: null,
    errorReportReceived: false,
  };

  static getDerivedStateFromError(error: unknown): Partial<RendererErrorBoundaryState> {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error)
    };
  }

  /**
   * One capture and one automatic report per crash, not per re-render.
   * `componentDidCatch` is React's once-per-caught-error hook
   * (`getDerivedStateFromError` can run twice under StrictMode), and this flag
   * covers a boundary that catches again after a failed recovery.
   */
  private crashHandled = false;

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    // Web client after a deploy: a lazy screen's old chunk is gone. The page
    // reloads into the new build; nothing here is broken.
    if (reloadForStaleChunk(error)) return;
    if (!this.crashHandled) {
      this.crashHandled = true;
      const crashEventId = captureError(error, {
        handled: false,
        level: "fatal",
        tags: { boundary: "root", route: window.location.hash || window.location.pathname },
        extra: { componentStack: info.componentStack ?? null },
      });
      this.setState({ crashEventId });
      void confirmSentryDelivery(crashEventId).then((received) => {
        if (received) this.setState({ errorReportReceived: true });
      });
      // Main owns the setting and the budget; this is a request, and its answer
      // is deliberately uninteresting to a screen that is already broken.
      if (isAdeAvailable(window.ade?.diagnostics?.autoReport)) {
        void window.ade.diagnostics.autoReport({
          surface: "renderer_crash",
          code: "renderer_crash",
          headline: RENDERER_CRASH_HEADLINE,
        }).catch((reason: unknown) => logRendererDebugEvent("renderer.auto_report_failed", {
          surface: "renderer_crash",
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      }
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
              icon={<WarningCircle size={14} weight="bold" aria-hidden="true" />}
              headline={RENDERER_CRASH_HEADLINE}
              body={
                <>
                  Something went wrong while drawing the app. Your project, chats and files are
                  safe — reloading reopens everything where it was.
                </>
              }
            >
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

              <ReportIssueFooter
                errorReportReceived={this.state.errorReportReceived}
                context={{
                  surface: "renderer_crash",
                  headline: RENDERER_CRASH_HEADLINE,
                  technicalDetail: this.state.message || null,
                  sentryEventId: this.state.crashEventId,
                }}
              />
            </ErrorSurfaceCard>

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
