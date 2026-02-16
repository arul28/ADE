import React from "react";
import { HashRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell";
import { ProjectHomePage } from "../project/ProjectHomePage";
import { LanesPage } from "../lanes/LanesPage";
import { FilesPage } from "../files/FilesPage";
import { TerminalsPage } from "../terminals/TerminalsPage";
import { ConflictsPage } from "../conflicts/ConflictsPage";
import { ContextPage } from "../context/ContextPage";
import { WorkspaceGraphPage } from "../graph/WorkspaceGraphPage";
import { PRsPage } from "../prs/PRsPage";
import { HistoryPage } from "../history/HistoryPage";
import { AutomationsPage } from "../automations/AutomationsPage";
import { SettingsPage } from "./SettingsPage";
import { StartupAuthPage } from "./StartupAuthPage";
import { OnboardingPage } from "../onboarding/OnboardingPage";

import { useAppStore } from "../../state/appStore";

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
          <Route path="/startup" element={<StartupAuthPage />} />
          <Route element={<ShellLayout />}>
            <Route path="/" element={<Navigate to="/startup" replace />} />
            <Route path="/project" element={<ProjectHomePage />} />
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route path="/lanes" element={<LanesPage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/terminals" element={<TerminalsPage />} />
            <Route path="/conflicts" element={<ConflictsPage />} />
            <Route path="/context" element={<ContextPage />} />
            <Route path="/graph" element={<WorkspaceGraphPage />} />
            <Route path="/prs" element={<PRsPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/automations" element={<AutomationsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </div>
    </HashRouter>
  );
}
