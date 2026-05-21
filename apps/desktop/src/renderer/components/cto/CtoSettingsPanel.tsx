import React, { useState } from "react";
import { ArrowCounterClockwise, PencilSimple } from "@phosphor-icons/react";
import type { CtoIdentity, CtoSessionLogEntry } from "../../../shared/types";
import { IdentityEditor } from "./IdentityEditor";
import { TimelineEntry } from "./shared/TimelineEntry";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { SmartTooltip } from "../ui/SmartTooltip";
import { getCtoPersonalityPreset } from "./identityPresets";
import { CtoPromptPreview } from "./CtoPromptPreview";

const CARD_CLASS = "rounded-xl border border-white/[0.07] bg-[linear-gradient(180deg,rgba(26,24,48,0.7),rgba(18,16,34,0.8))] p-4 shadow-card backdrop-blur-[20px]";

function describeIdentityPersonality(identity: CtoIdentity): string {
  if (identity.personality === "custom") {
    return identity.customPersonality?.trim() || identity.persona || "Custom personality configured.";
  }
  return getCtoPersonalityPreset(identity.personality ?? "strategic").description;
}

export function CtoSettingsPanel({
  identity,
  sessionLogs,
  onSaveIdentity,
  onResetOnboarding,
}: {
  identity: CtoIdentity | null;
  sessionLogs: CtoSessionLogEntry[];
  onSaveIdentity: (patch: Record<string, unknown>) => Promise<void>;
  onResetOnboarding?: () => void;
}) {
  const [identityEditing, setIdentityEditing] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"identity" | "history">("identity");

  const subTabs = [
    { id: "identity" as const, label: "Identity", tooltip: "CTO personality, model, and reasoning configuration." },
    { id: "history" as const, label: "History", tooltip: "Recent CTO sessions and continuity context." },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div className="flex items-center gap-1">
        {subTabs.map(({ id, label, tooltip }) => (
          <SmartTooltip key={id} content={{ label, description: tooltip }} side="bottom">
            <button
              type="button"
              onClick={() => setSettingsTab(id)}
              className={cn(
                "rounded-md border px-3 py-1.5 text-xs font-medium transition-all duration-150",
                settingsTab === id
                  ? "border-accent/20 bg-accent/10 text-accent"
                  : "border-transparent text-muted-fg/50 hover:bg-white/[0.03] hover:text-muted-fg/80",
              )}
            >
              {label}
            </button>
          </SmartTooltip>
        ))}
        {onResetOnboarding && (
          <Button variant="ghost" size="sm" className="ml-auto !text-[10px] text-muted-fg/40" onClick={onResetOnboarding}>
            <ArrowCounterClockwise size={10} />
            Re-run setup
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        {settingsTab === "identity" && (
          <>
            {identityEditing ? (
              <IdentityEditor identity={identity} onSave={onSaveIdentity} onCancel={() => setIdentityEditing(false)} />
            ) : identity ? (
              <div className="space-y-4">
                <div className={CARD_CLASS} style={{ borderLeft: "3px solid var(--color-accent)" }}>
                  <div className="mb-3 flex items-center justify-between">
                    <div className="text-xs font-semibold text-fg">CTO identity</div>
                    <Button variant="outline" size="sm" onClick={() => setIdentityEditing(true)}>
                      <PencilSimple size={10} /> Edit
                    </Button>
                  </div>
                  <div className="mb-3 text-xs leading-relaxed text-muted-fg/55">{describeIdentityPersonality(identity)}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { label: `${identity.modelPreferences.provider}/${identity.modelPreferences.model}` },
                      ...(identity.personality ? [{ label: getCtoPersonalityPreset(identity.personality).label }] : []),
                      ...(identity.modelPreferences.reasoningEffort ? [{ label: `reasoning: ${identity.modelPreferences.reasoningEffort}` }] : []),
                    ].map((tag) => (
                      <span key={tag.label} className="rounded-md border border-accent/15 bg-accent/8 px-2 py-0.5 text-[10px] font-medium text-accent">
                        {tag.label}
                      </span>
                    ))}
                  </div>
                </div>

                <div className={CARD_CLASS} style={{ borderLeft: "3px solid #60A5FA" }}>
                  <div className="mb-3 text-xs font-semibold text-fg">Prompt preview</div>
                  <CtoPromptPreview compact />
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-fg/40">Loading...</div>
            )}
          </>
        )}

        {settingsTab === "history" && (
          <div className={CARD_CLASS} style={{ borderLeft: "3px solid #FBBF24" }}>
            <div className="mb-3 text-xs font-semibold text-fg">Session history</div>
            <div className="max-h-80 space-y-1 overflow-y-auto" data-testid="session-history-list">
              {sessionLogs.length === 0 ? (
                <div className="py-2 text-[10px] text-muted-fg/40">No sessions yet.</div>
              ) : sessionLogs.map((session) => (
                <TimelineEntry
                  key={session.id}
                  timestamp={session.createdAt}
                  title={session.summary}
                  status={session.capabilityMode}
                  statusVariant={session.capabilityMode === "full_tooling" ? "success" : "muted"}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
