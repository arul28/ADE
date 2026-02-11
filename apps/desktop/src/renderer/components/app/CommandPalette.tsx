import React, { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "../ui/Button";
import { Kbd } from "../ui/Kbd";
import { cn } from "../ui/cn";

type Command = {
  id: string;
  title: string;
  hint?: string;
  shortcut?: string;
  run: () => void;
};

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  const commands: Command[] = useMemo(
    () => [
      { id: "go-project", title: "Go to Projects (Home)", shortcut: "G 1", run: () => navigate("/project") },
      { id: "go-lanes", title: "Go to Lanes", shortcut: "G L", run: () => navigate("/lanes") },
      { id: "go-terminals", title: "Go to Terminals", shortcut: "G T", run: () => navigate("/terminals") },
      { id: "go-conflicts", title: "Go to Conflicts", shortcut: "G C", run: () => navigate("/conflicts") },
      { id: "go-prs", title: "Go to PRs", shortcut: "G R", run: () => navigate("/prs") },
      { id: "go-history", title: "Go to History", shortcut: "G H", run: () => navigate("/history") },
      { id: "go-settings", title: "Go to Settings", shortcut: "G S", run: () => navigate("/settings") },
      {
        id: "ping",
        title: "Ping preload bridge",
        hint: "Expect \"pong\"",
        run: async () => {
          const pong = await window.ade.app.ping();
          // eslint-disable-next-line no-console
          console.log("ade.app.ping ->", pong);
        }
      }
    ],
    [navigate]
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) => c.title.toLowerCase().includes(needle) || (c.hint ?? "").toLowerCase().includes(needle));
  }, [commands, q]);

  const runFirst = async () => {
    const cmd = filtered[0];
    if (!cmd) return;
    await Promise.resolve(cmd.run());
    onOpenChange(false);
    setQ("");
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setQ("");
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-[18%] w-[min(720px,calc(100vw-24px))] -translate-x-1/2 rounded-xl border border-border bg-card/90 p-3 shadow-2xl backdrop-blur",
            "focus:outline-none"
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title className="text-sm font-semibold">Command palette</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm">
                Esc
              </Button>
            </Dialog.Close>
          </div>

          <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-card/70 px-2">
            <Search className="h-4 w-4 text-muted-fg" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  runFirst();
                }
              }}
              placeholder="Type a command..."
              className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-fg"
              autoFocus
            />
            <Kbd className="hidden sm:inline-flex">Enter</Kbd>
          </div>

          <div className="mt-3 max-h-[45vh] overflow-auto rounded-lg border border-border">
            {filtered.length === 0 ? (
              <div className="p-4 text-sm text-muted-fg">No matches.</div>
            ) : (
              <ul className="divide-y divide-border">
                {filtered.map((cmd) => (
                  <li key={cmd.id}>
                    <button
                      className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left text-sm hover:bg-muted/50"
                      onClick={() => {
                        Promise.resolve(cmd.run()).finally(() => {
                          onOpenChange(false);
                          setQ("");
                        });
                      }}
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{cmd.title}</div>
                        {cmd.hint ? <div className="truncate text-xs text-muted-fg">{cmd.hint}</div> : null}
                      </div>
                      <div className="flex items-center gap-2 text-muted-fg">
                        {cmd.shortcut ? <span className="hidden sm:inline text-xs">{cmd.shortcut}</span> : null}
                        <ArrowRight className="h-4 w-4" />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
