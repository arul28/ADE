import React, { useEffect, useMemo, useState } from "react";
import { CommandPalette } from "./CommandPalette";
import { TabNav } from "./TabNav";
import { TopBar } from "./TopBar";
import { useAppStore } from "../../state/appStore";

export function AppShell({ children }: { children: React.ReactNode }) {
  const setProject = useAppStore((s) => s.setProject);
  const [commandOpen, setCommandOpen] = useState(false);

  useEffect(() => {
    window.ade.app
      .getProject()
      .then(setProject)
      .catch(() => {
        // Leave project unset; UI will show placeholders.
      });
  }, [setProject]);

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
    <div className="h-screen w-screen text-fg">
      <TopBar
        onOpenCommandPalette={() => setCommandOpen(true)}
        commandHint={
          <>
            {cmdK}+<span className="font-mono">K</span>
          </>
        }
      />
      <div className="grid h-[calc(100vh-52px)] grid-cols-[240px_1fr] gap-3 p-3">
        <TabNav />
        <main className="min-w-0 overflow-hidden">{children}</main>
      </div>

      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
    </div>
  );
}

