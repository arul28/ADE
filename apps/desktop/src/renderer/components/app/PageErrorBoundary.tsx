import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { WarningCircle } from "@phosphor-icons/react";
import { logRendererDebugEvent } from "../../lib/debugLog";
import { captureError, isSentryActive } from "../../../shared/sentry/capture";
import {
  ERROR_PRIMARY_BUTTON,
  ERROR_SECONDARY_BUTTON,
  ErrorSurfaceCard,
  TechnicalDetailsFold,
} from "./errorSurfaceKit";
import { CrashReportFooter } from "./CrashReportFooter";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { isChunkLoadFailure, reloadForStaleChunk } from "../../lib/staleChunkReload";

/**
 * Per-route error boundary. One screen failing to draw must never take the
 * window with it, and the way out of a broken screen must actually leave it.
 */

const PAGE_CRASH_HEADLINE = "Something went wrong on this screen";

type PageErrorBoundaryState = {
  hasError: boolean;
  message: string;
  /** A lazy screen's file failed to load, so Try again has to reload the page. */
  chunkFailure: boolean;
  /** The crash went to Sentry; set once `componentDidCatch` has sent it. */
  autoReported: boolean;
};

const CLEAR_STATE: PageErrorBoundaryState = { hasError: false, message: "", chunkFailure: false, autoReported: false };

class PageErrorBoundaryInner extends React.Component<
  { children: React.ReactNode; onGoHome: () => void; goHomeLabel: string },
  PageErrorBoundaryState
> {
  state: PageErrorBoundaryState = CLEAR_STATE;

  /** One automatic diagnostic report per boundary, however often the screen breaks again. */
  private autoReportRequested = false;

  static getDerivedStateFromError(error: unknown): Partial<PageErrorBoundaryState> {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
      chunkFailure: isChunkLoadFailure(error),
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Web client after a deploy: this page's old chunk is gone; reload into the new build.
    if (reloadForStaleChunk(error)) return;
    console.error("page.crash", error, errorInfo, error?.stack);
    captureError(error, {
      handled: false,
      tags: { boundary: "page", route: window.location.hash || window.location.pathname },
      extra: { componentStack: errorInfo.componentStack ?? null },
    });
    if (isSentryActive()) this.setState({ autoReported: true });
    // Desktop: ask main for the diagnostic report with ADE's logs, as the
    // window boundary does. Main owns the setting and the budget (one per
    // failure code a day); the web client's Sentry capture above is its report.
    if (!this.autoReportRequested && isAdeAvailable(window.ade?.diagnostics?.autoReport)) {
      this.autoReportRequested = true;
      void window.ade.diagnostics.autoReport({
        surface: "page_crash",
        code: "page_crash",
        headline: PAGE_CRASH_HEADLINE,
        technicalDetail: error?.message ?? null,
      }).catch(() => undefined);
    }
    logRendererDebugEvent("renderer.page_boundary_crash", {
      message: error?.message ?? String(error),
      route: window.location.hash || window.location.pathname,
      componentStack: errorInfo.componentStack ?? null,
      causeStack: error?.stack ?? null,
    });
  }

  render() {
    if (this.state.hasError) {
      const { chunkFailure, autoReported, message } = this.state;
      return (
        <div className="h-full w-full overflow-y-auto text-fg">
          {/* Min-height row rather than `items-center` on the scroller: a card
              taller than the pane would otherwise be clipped at the top. */}
          <div className="flex min-h-full items-center justify-center p-8">
          <div className="w-full max-w-[520px]">
            <ErrorSurfaceCard
              icon={<WarningCircle size={14} weight="bold" aria-hidden="true" />}
              headline={PAGE_CRASH_HEADLINE}
              body="The rest of ADE is still running — your project, chats and files are safe."
            >
              <div className="mt-5 flex flex-wrap items-center gap-2">
                {/* Leaving first: this screen just failed to draw, so
                    re-rendering it usually fails the same way. Leaving is the
                    move that reliably works — which is why the destination is
                    never the route that just threw — and Try again stays for
                    the transient case. */}
                <button
                  type="button"
                  className={ERROR_PRIMARY_BUTTON}
                  onClick={() => {
                    this.setState(CLEAR_STATE);
                    this.props.onGoHome();
                  }}
                >
                  {this.props.goHomeLabel}
                </button>
                <button
                  type="button"
                  className={ERROR_SECONDARY_BUTTON}
                  onClick={() => {
                    // A lazy screen remembers that its file failed to load, so
                    // drawing it again fails again; a reload fetches it anew.
                    if (chunkFailure) {
                      window.location.reload();
                      return;
                    }
                    this.setState(CLEAR_STATE);
                  }}
                >
                  Try again
                </button>
              </div>

              <CrashReportFooter
                autoReported={autoReported}
                context={{
                  surface: "page_crash",
                  headline: PAGE_CRASH_HEADLINE,
                  technicalDetail: message || null,
                }}
              />
            </ErrorSurfaceCard>

            <TechnicalDetailsFold
              text={message || "No error message was recorded."}
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

export function PageErrorBoundary({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  // Work is home for every other screen, but it cannot be its own escape
  // hatch: sending a crashed Work route back to /work remounts the route that
  // just threw and draws this same card again. Lanes is the neighbouring
  // top-level tab and does not depend on anything Work owns.
  const crashedOnWork = location.pathname === "/work" || location.pathname.startsWith("/work/");
  return (
    <PageErrorBoundaryInner
      goHomeLabel={crashedOnWork ? "Go to Lanes" : "Go to Work"}
      onGoHome={() => navigate(crashedOnWork ? "/lanes" : "/work")}
    >
      {children}
    </PageErrorBoundaryInner>
  );
}
