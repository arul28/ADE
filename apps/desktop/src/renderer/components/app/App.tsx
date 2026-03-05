import React from "react";
import {
  BrowserRouter,
  HashRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate
} from "react-router-dom";

// Use BrowserRouter when running in a regular browser (for Figma capture compatibility).
// The browser mock sets __isBrowserMock when window.ade is stubbed.
const Router = (window as any).__adeBrowserMock ? BrowserRouter : HashRouter;
import { AppShell } from "./AppShell";
import { RunPage } from "../run/RunPage";
import { ConflictsPage } from "../conflicts/ConflictsPage";
import { OnboardingPage } from "../onboarding/OnboardingPage";

const LanesPage = React.lazy(() =>
  import("../lanes/LanesPage").then((m) => ({ default: m.LanesPage }))
);
const FilesPage = React.lazy(() =>
  import("../files/FilesPage").then((m) => ({ default: m.FilesPage }))
);
const TerminalsPage = React.lazy(() =>
  import("../terminals/TerminalsPage").then((m) => ({ default: m.TerminalsPage }))
);
const PRsPage = React.lazy(() =>
  import("../prs/PRsPage").then((m) => ({ default: m.PRsPage }))
);
const HistoryPage = React.lazy(() =>
  import("../history/HistoryPage").then((m) => ({ default: m.HistoryPage }))
);
const AutomationsPage = React.lazy(() =>
  import("../automations/AutomationsPage").then((m) => ({ default: m.AutomationsPage }))
);
const SettingsPage = React.lazy(() =>
  import("./SettingsPage").then((m) => ({ default: m.SettingsPage }))
);
const WorkspaceGraphPage = React.lazy(() =>
  import("../graph/WorkspaceGraphPage").then((m) => ({ default: m.WorkspaceGraphPage }))
);
const MissionsPage = React.lazy(() =>
  import("../missions/MissionsPage").then((m) => ({ default: m.MissionsPage }))
);
const CtoPage = React.lazy(() =>
  import("../cto/CtoPage").then((m) => ({ default: m.CtoPage }))
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

function RequireProject({ children }: { children: React.ReactElement }): React.ReactElement {
  const showWelcome = useAppStore((s) => s.showWelcome);
  const project = useAppStore((s) => s.project);
  const location = useLocation();

  const hasActiveProject = Boolean(project?.rootPath);
  if ((!hasActiveProject || showWelcome) && location.pathname !== "/project" && location.pathname !== "/onboarding") {
    return <Navigate to="/project" replace />;
  }

  return children;
}

const LazyFallback = (
  <div className="flex h-full w-full items-center justify-center">
    <div className="text-xs text-muted-fg/60">Loading...</div>
  </div>
);

function guarded(element: React.ReactElement): React.ReactElement {
  return (
    <RequireProject>
      <PageErrorBoundary>{element}</PageErrorBoundary>
    </RequireProject>
  );
}

function guardedLazy(element: React.ReactElement): React.ReactElement {
  return (
    <RequireProject>
      <PageErrorBoundary>
        <React.Suspense fallback={LazyFallback}>{element}</React.Suspense>
      </PageErrorBoundary>
    </RequireProject>
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
    <Router>
      <div data-theme={theme} className="h-full bg-bg text-fg font-sans antialiased selection:bg-accent/30">
        <Routes>
          <Route path="/startup" element={<Navigate to="/project" replace />} />
          <Route element={<ShellLayout />}>
            <Route path="/" element={<Navigate to="/project" replace />} />
            <Route path="/project" element={guarded(<RunPage />)} />
            <Route path="/onboarding" element={guarded(<OnboardingPage />)} />
            <Route path="/lanes" element={guardedLazy(<LanesPage />)} />
            <Route path="/files" element={guardedLazy(<FilesPage />)} />
            <Route path="/work" element={guardedLazy(<TerminalsPage />)} />
            <Route path="/conflicts" element={guarded(<ConflictsPage />)} />
            <Route path="/graph" element={guardedLazy(<WorkspaceGraphPage />)} />
            <Route path="/prs" element={guardedLazy(<PRsPage />)} />
            <Route path="/history" element={guardedLazy(<HistoryPage />)} />
            <Route path="/automations" element={guardedLazy(<AutomationsPage />)} />
            <Route path="/missions" element={guardedLazy(<MissionsPage />)} />
            <Route path="/cto" element={guardedLazy(<CtoPage />)} />
            <Route path="/settings" element={guardedLazy(<SettingsPage />)} />
            <Route path="*" element={<Navigate to="/project" replace />} />
          </Route>
        </Routes>
      </div>
    </Router>
  );
}
