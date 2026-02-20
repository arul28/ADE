import React, { useState } from "react";
import { Settings, GitBranch, BookOpenText, Wand2, TerminalSquare, Keyboard } from "lucide-react";
import { cn } from "../ui/cn";
import { GeneralSection } from "../settings/GeneralSection";
import { GitHubSection } from "../settings/GitHubSection";
import { ContextSection } from "../settings/ContextSection";
import { AutomationsSection } from "../settings/AutomationsSection";
import { TerminalProfilesSection } from "../settings/TerminalProfilesSection";
import { KeybindingsSection } from "../settings/KeybindingsSection";

const SECTIONS = [
  { id: "general", label: "General", icon: Settings },
  { id: "github", label: "GitHub", icon: GitBranch },
  { id: "context", label: "Context & Docs", icon: BookOpenText },
  { id: "automations", label: "Automations", icon: Wand2 },
  { id: "terminals", label: "Terminals", icon: TerminalSquare },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsPage() {
  const [section, setSection] = useState<SectionId>("general");

  return (
    <div className="flex h-full overflow-hidden rounded border border-border/40 bg-card">
      {/* Left sidebar */}
      <nav className="w-[180px] shrink-0 border-r border-border bg-card/30 py-3 px-2">
        <div className="text-[10px] uppercase tracking-wider text-muted-fg px-2 mb-2">Settings</div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSection(s.id)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
              section === s.id
                ? "bg-accent/15 text-accent font-medium"
                : "text-muted-fg hover:bg-muted/30 hover:text-fg"
            )}
          >
            <s.icon className="h-4 w-4 shrink-0" />
            {s.label}
          </button>
        ))}
      </nav>

      {/* Right content */}
      <div className="flex-1 overflow-auto p-4">
        {section === "general" && <GeneralSection />}
        {section === "github" && <GitHubSection />}
        {section === "context" && <ContextSection />}
        {section === "automations" && <AutomationsSection />}
        {section === "terminals" && <TerminalProfilesSection />}
        {section === "keybindings" && <KeybindingsSection />}
      </div>
    </div>
  );
}
