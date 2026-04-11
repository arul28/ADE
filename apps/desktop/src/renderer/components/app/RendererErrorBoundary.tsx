import React from "react";
import { logRendererDebugEvent } from "../../lib/debugLog";

type RendererErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

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

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
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
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-bg p-4 text-fg">
          <div className="max-w-[720px] rounded border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
            <div className="font-semibold">Renderer crashed</div>
            <div className="mt-1 text-xs">{this.state.message || "Unknown error"}</div>
          </div>
          <button
            type="button"
            className="rounded border border-border bg-card px-3 py-1 text-sm"
            onClick={() => window.location.reload()}
          >
            Reload app
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
