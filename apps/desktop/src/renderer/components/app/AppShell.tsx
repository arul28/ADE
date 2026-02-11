import React, { useEffect, useMemo, useState } from "react";
import { CommandPalette } from "./CommandPalette";
import { TabNav } from "./TabNav";
import { TopBar } from "./TopBar";
import { useAppStore } from "../../state/appStore";

export function AppShell({ children }: { children: React.ReactNode }) {
  const setProject = useAppStore((s) => s.setProject);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const [commandOpen, setCommandOpen] = useState(false);

  useEffect(() => {
    window.ade.app
      .getProject()
      .then(setProject)
      .then(() => refreshLanes())
      .catch(() => {
        // Leave project unset; UI will show placeholders.
      });
  }, [setProject, refreshLanes]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const cmdK = useMemo(() => (navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl"), []);

  return (
    <div className="h-screen w-screen text-fg overflow-hidden flex flex-col bg-bg">
      {/* TopBar is now part of the 'paper' flow - less like a floating header */
      /* CONSOLE LAYOUT: Integrated Header */}
      <div className="shrink-0 border-b border-border bg-bg relative z-20">
        <TopBar
          onOpenCommandPalette={() => setCommandOpen(true)}
          commandHint={
            <>
              {cmdK}+<span className="font-mono">K</span>
            </>
          }
        />
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Sidebar Navigation - High contrast, distinct pane */}
        <aside className="w-[50px] shrink-0 border-r border-border bg-bg flex flex-col items-center py-2 z-10">
          <TabNav />
        </aside>

        {/* Main Workspace - Canvas for Lanes/Content */}
        <main className="flex-1 min-w-0 bg-bg relative">
          {children}
        </main>
      </div>

      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
    </div>
  );
}
