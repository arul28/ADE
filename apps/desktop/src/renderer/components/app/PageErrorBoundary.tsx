import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { WarningCircle } from "@phosphor-icons/react";
import { logRendererDebugEvent } from "../../lib/debugLog";
import {
  ERROR_PRIMARY_BUTTON,
  ERROR_SECONDARY_BUTTON,
  ErrorSurfaceCard,
  TechnicalDetailsFold,
  WhatToDo,
} from "./errorSurfaceKit";
import { ReportIssueButton } from "./ReportIssueButton";

/**
 * Per-route error boundary. One screen failing to draw must never take the
 * window with it, and the way out of a broken screen must actually leave it.
 */

const pageCrashSteps = (goHomeLabel: string): readonly string[] => [
  `${goHomeLabel} — the rest of ADE keeps running.`,
  "Come back to this screen. If it breaks again, choose Report issue so we can see what happened here.",
];

type PageErrorBoundaryState = { hasError: boolean; message: string };

class PageErrorBoundaryInner extends React.Component<
  { children: React.ReactNode; onGoHome: () => void; goHomeLabel: string },
  PageErrorBoundaryState
> {
  state: PageErrorBoundaryState = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown): PageErrorBoundaryState {
    return { hasError: true, message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("page.crash", error, errorInfo, error?.stack);
    logRendererDebugEvent("renderer.page_boundary_crash", {
      message: error?.message ?? String(error),
      route: window.location.hash || window.location.pathname,
      componentStack: errorInfo.componentStack ?? null,
      causeStack: error?.stack ?? null,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-full w-full overflow-y-auto text-fg">
          {/* Min-height row rather than `items-center` on the scroller: a card
              taller than the pane would otherwise be clipped at the top. */}
          <div className="flex min-h-full items-center justify-center p-8">
          <div className="w-full max-w-[520px]">
            <ErrorSurfaceCard
              icon={<WarningCircle size={18} weight="fill" aria-hidden="true" />}
              headline="Something went wrong on this screen"
              body="The rest of ADE is still running, and your project, chats and files are safe."
            >
              <WhatToDo
                title="What to do"
                steps={pageCrashSteps(this.props.goHomeLabel)}
              />

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
                    this.setState({ hasError: false, message: "" });
                    this.props.onGoHome();
                  }}
                >
                  {this.props.goHomeLabel}
                </button>
                <button
                  type="button"
                  className={ERROR_SECONDARY_BUTTON}
                  onClick={() => this.setState({ hasError: false, message: "" })}
                >
                  Try again
                </button>
              </div>
            </ErrorSurfaceCard>

            <div className="mt-4">
              <ReportIssueButton
                variant="secondary"
                context={{
                  surface: "page_crash",
                  headline: "Something went wrong on this screen",
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
