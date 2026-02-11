import React from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell";
import { ProjectHomePage } from "../project/ProjectHomePage";
import { LanesPage } from "../lanes/LanesPage";
import { TerminalsPage } from "../terminals/TerminalsPage";
import { ConflictsPage } from "../conflicts/ConflictsPage";
import { PRsPage } from "../prs/PRsPage";
import { HistoryPage } from "../history/HistoryPage";
import { SettingsPage } from "./SettingsPage";

export function App() {
  return (
    <HashRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<Navigate to="/project" replace />} />
          <Route path="/project" element={<ProjectHomePage />} />
          <Route path="/lanes" element={<LanesPage />} />
          <Route path="/terminals" element={<TerminalsPage />} />
          <Route path="/conflicts" element={<ConflictsPage />} />
          <Route path="/prs" element={<PRsPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </AppShell>
    </HashRouter>
  );
}
