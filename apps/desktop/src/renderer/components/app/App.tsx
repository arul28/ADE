import React from "react";
import { HashRouter, Navigate, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { AppShell } from "./AppShell";
import { ProjectHomePage } from "../project/ProjectHomePage";
import { LanesPage } from "../lanes/LanesPage";
import { FilesPage } from "../files/FilesPage";
import { TerminalsPage } from "../terminals/TerminalsPage";
import { ConflictsPage } from "../conflicts/ConflictsPage";
import { PRsPage } from "../prs/PRsPage";
import { HistoryPage } from "../history/HistoryPage";
import { AutomationsPage } from "../automations/AutomationsPage";
import { SettingsPage } from "./SettingsPage";
import { OnboardingPage } from "../onboarding/OnboardingPage";

const WorkspaceGraphPage = React.lazy(() =>
  import("../graph/WorkspaceGraphPage").then((m) => ({ default: m.WorkspaceGraphPage }))
);
const MissionsPage = React.lazy(() =>
  import("../missions/MissionsPage").then((m) => ({ default: m.MissionsPage }))
);

import { useAppStore } from "../../state/appStore";

/* ---------- Per-route error boundary ---------- */

type PageErrorBoundaryState = { hasError: boolean; message: string };

class PageErrorBoundaryInner extends React.Component<
  { children: React.ReactNode; onGoHome: () => void },
  PageErrorBoundaryState
> {
  state: PageErrorBoundaryState = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown): PageErrorBoundaryState {
    return { hasError: true, message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown): void {
    console.error("page.crash", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-fg">
          <div className="max-w-[560px] rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm">
            <div className="font-semibold text-red-300">This page crashed</div>
            <div className="mt-1 text-xs text-muted-fg">{this.state.message || "Unknown error"}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted/30 transition-colors"
              onClick={() => this.setState({ hasError: false, message: "" })}
            >
              Retry
            </button>
            <button
              type="button"
              className="rounded border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted/30 transition-colors"
              onClick={() => {
                this.setState({ hasError: false, message: "" });
                this.props.onGoHome();
              }}
            >
              Go Home
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function PageErrorBoundary({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  return (
    <PageErrorBoundaryInner onGoHome={() => navigate("/project")}>
      {children}
    </PageErrorBoundaryInner>
  );
}

const LazyFallback = (
  <div className="flex h-full w-full items-center justify-center">
    <div className="text-xs text-muted-fg/60">Loading...</div>
  </div>
);

function guarded(element: React.ReactElement): React.ReactElement {
  return <PageErrorBoundary>{element}</PageErrorBoundary>;
}

function guardedLazy(element: React.ReactElement): React.ReactElement {
  return (
    <PageErrorBoundary>
      <React.Suspense fallback={LazyFallback}>{element}</React.Suspense>
    </PageErrorBoundary>
  );
}
function ShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export function App() {
  const theme = useAppStore((s) => s.theme);

  React.useEffect(() => {
    // Keep theme consistent for portals mounted outside the app root.
    document.documentElement.setAttribute("data-theme", theme);
    document.body.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <HashRouter>
      <div data-theme={theme} className="h-full bg-bg text-fg font-sans antialiased selection:bg-accent/30">
        <Routes>
          <Route path="/startup" element={<Navigate to="/project" replace />} />
          <Route element={<ShellLayout />}>
            <Route path="/" element={<Navigate to="/project" replace />} />
            <Route path="/project" element={guarded(<ProjectHomePage />)} />
            <Route path="/onboarding" element={guarded(<OnboardingPage />)} />
            <Route path="/lanes" element={guarded(<LanesPage />)} />
            <Route path="/files" element={guarded(<FilesPage />)} />
            <Route path="/terminals" element={<Navigate to="/work" replace />} />
            <Route path="/work" element={guarded(<TerminalsPage />)} />
            <Route path="/conflicts" element={guarded(<ConflictsPage />)} />
            <Route path="/context" element={<Navigate to="/settings" replace />} />
            <Route path="/graph" element={guardedLazy(<WorkspaceGraphPage />)} />
            <Route path="/prs" element={guarded(<PRsPage />)} />
            <Route path="/history" element={guarded(<HistoryPage />)} />
            <Route path="/automations" element={guarded(<AutomationsPage />)} />
            <Route path="/missions" element={guardedLazy(<MissionsPage />)} />
            <Route path="/settings" element={guarded(<SettingsPage />)} />
          </Route>
        </Routes>
      </div>
    </HashRouter>
  );
}
