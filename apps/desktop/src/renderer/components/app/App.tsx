import React from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell";
import { ProjectHomePage } from "../project/ProjectHomePage";
import { LanesPage } from "../lanes/LanesPage";
import { FilesPage } from "../files/FilesPage";
import { TerminalsPage } from "../terminals/TerminalsPage";
import { ConflictsPage } from "../conflicts/ConflictsPage";
import { PRsPage } from "../prs/PRsPage";
import { HistoryPage } from "../history/HistoryPage";
import { SettingsPage } from "./SettingsPage";

import { useAppStore } from "../../state/appStore";

export function App() {
  const theme = useAppStore((s) => s.theme);

  React.useEffect(() => {
    // Keep theme consistent for portals mounted outside the app root.
    document.documentElement.setAttribute("data-theme", theme);
    document.body.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <HashRouter>
      <div data-theme={theme} className="h-full bg-bg text-fg font-mono antialiased selection:bg-accent/30">
        <AppShell>
          <Routes>
            <Route path="/" element={<Navigate to="/project" replace />} />
            <Route path="/project" element={<ProjectHomePage />} />
            <Route path="/lanes" element={<LanesPage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/terminals" element={<TerminalsPage />} />
            <Route path="/conflicts" element={<ConflictsPage />} />
            <Route path="/prs" element={<PRsPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </AppShell>
      </div>
    </HashRouter>
  );
}
