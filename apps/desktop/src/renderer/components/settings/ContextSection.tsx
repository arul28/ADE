import React from "react";
import type { ContextStatus, ContextRefreshEvents, ContextDocPrefs, SkillIndexEntry } from "../../../shared/types";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";
import { EmptyState } from "../ui/EmptyState";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  LABEL_STYLE,
  cardStyle,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontFamily: SANS_FONT,
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase" as const,
  marginBottom: 10,
};

function relativeTime(value: string | null | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Event Toggles
   ═══════════════════════════════════════════════════════════════════════════ */

type EventToggle = {
  key: keyof ContextRefreshEvents;
  label: string;
  help: string;
};

const EVENT_TOGGLES: EventToggle[] = [
  { key: "onSessionEnd", label: "On session end", help: "Regen when a terminal/agent session ends." },
  { key: "onCommit", label: "On commit", help: "Regen when a commit is created." },
  { key: "onPrCreate", label: "On PR create", help: "Regen when a pull request is created or updated." },
  { key: "onPrLand", label: "On PR land", help: "Regen when a pull request is landed/merged." },
  { key: "onMissionStart", label: "On mission start", help: "Regen when a mission launches." },
  { key: "onMissionEnd", label: "On mission end", help: "Regen when a mission completes." },
  { key: "onLaneCreate", label: "On lane create", help: "Regen when a new lane is created." },
];

const DEFAULT_EVENTS: ContextRefreshEvents = { onPrCreate: true, onMissionStart: true };

/* ═══════════════════════════════════════════════════════════════════════════
   Context Section
   ═══════════════════════════════════════════════════════════════════════════ */

export function ContextSection() {
  const [docsStatus, setDocsStatus] = React.useState<ContextStatus | null>(null);
  const [docsLoading, setDocsLoading] = React.useState(false);

  // Generation config state
  const [modelId, setModelId] = React.useState("claude-sonnet-4-6");
  const [reasoningEffort, setReasoningEffort] = React.useState<string | null>(null);
  const [events, setEvents] = React.useState<ContextRefreshEvents>({ ...DEFAULT_EVENTS });
  const [availableModelIds, setAvailableModelIds] = React.useState<string[]>([]);
  const [loadingModels, setLoadingModels] = React.useState(false);
  const [prefsLoaded, setPrefsLoaded] = React.useState(false);

  // Generation state
  const [generating, setGenerating] = React.useState(false);
  const [genResult, setGenResult] = React.useState<string | null>(null);
  const [genError, setGenError] = React.useState<string | null>(null);

  const reloadDocs = React.useCallback(async () => {
    setDocsLoading(true);
    try {
      const status = await window.ade.context.getStatus();
      setDocsStatus(status);
    } catch {
      setDocsStatus(null);
    } finally {
      setDocsLoading(false);
    }
  }, []);

  // Load saved prefs + available models on mount
  React.useEffect(() => {
    void reloadDocs();

    // Load backend prefs
    window.ade.context.getPrefs().then((prefs) => {
      if (prefs.modelId) setModelId(prefs.modelId);
      if (prefs.reasoningEffort) setReasoningEffort(prefs.reasoningEffort);
      if (prefs.events) {
        const hasAny = Object.values(prefs.events).some(Boolean);
        if (hasAny) setEvents(prefs.events);
      }
      setPrefsLoaded(true);
    }).catch(() => {
      setPrefsLoaded(true);
    });

    // Load available models
    let cancelled = false;
    setLoadingModels(true);
    window.ade.agentChat.models({ provider: "unified" })
      .then((models) => {
        if (cancelled) return;
        const ids = models
          .map((entry) => String(entry.modelId ?? entry.id ?? "").trim())
          .filter((entry) => entry.length > 0);
        setAvailableModelIds([...new Set(ids)]);
      })
      .catch(() => {
        if (!cancelled) setAvailableModelIds([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => { cancelled = true; };
  }, [reloadDocs]);

  // Auto-save prefs to backend whenever events/model/effort change (after initial load)
  const saveTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if (!prefsLoaded) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      void window.ade.context.savePrefs({
        provider: "unified",
        modelId,
        reasoningEffort,
        events,
      }).catch(() => {});
    }, 300);
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [prefsLoaded, modelId, reasoningEffort, events]);

  const toggleEvent = (key: keyof ContextRefreshEvents) => {
    setEvents((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setGenError(null);
    setGenResult(null);
    try {
      const result = await window.ade.context.generateDocs({
        provider: "unified",
        modelId,
        reasoningEffort,
        events,
      });
      setGenResult(`Docs updated at ${new Date(result.generatedAt).toLocaleString()}`);
      void reloadDocs();
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <>
      {/* ── Context Docs ── */}
      <section>
        <div style={sectionLabelStyle}>Context Docs</div>
        <div style={{ ...cardStyle({ padding: 16 }), display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary }}>
            Canonical docs remain the stable source for bootstrap and memory ingestion.
          </div>

          {docsLoading ? (
            <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>Loading docs status...</div>
          ) : docsStatus?.docs?.length ? (
            docsStatus.docs.map((doc) => (
              <div key={doc.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, borderRadius: 10, padding: "10px 12px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                  <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textPrimary }}>{doc.label}</div>
                  <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: doc.exists ? COLORS.success : COLORS.warning }}>
                    {doc.exists ? `present \u00b7 updated ${relativeTime(doc.updatedAt)}` : "missing"}
                  </div>
                  <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {doc.preferredPath}
                  </div>
                </div>
                <button
                  type="button"
                  style={outlineButton({ height: 26, padding: "0 10px", fontSize: 10, borderRadius: 8 })}
                  onClick={() => {
                    void window.ade.context.openDoc({ docId: doc.id }).catch(() => {});
                  }}
                >
                  Open
                </button>
              </div>
            ))
          ) : (
            <EmptyState title="Docs unavailable" description="Unable to read context doc status." />
          )}
        </div>
      </section>

      {/* ── Generation Config ── */}
      <section>
        <div style={sectionLabelStyle}>Generate Context Docs</div>
        <div style={{ ...cardStyle({ padding: 16 }), display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary }}>
            Choose a model and configure which events trigger automatic regeneration.
          </div>

          {/* Model selector */}
          <div>
            <div style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 500, color: COLORS.textSecondary, marginBottom: 6 }}>Model</div>
            <UnifiedModelSelector
              value={modelId}
              onChange={setModelId}
              availableModelIds={availableModelIds.length > 0 ? availableModelIds : undefined}
              showReasoning
              reasoningEffort={reasoningEffort}
              onReasoningEffortChange={setReasoningEffort}
              className="w-full"
            />
            {loadingModels ? (
              <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted, marginTop: 4 }}>Detecting configured models...</div>
            ) : null}
          </div>

          {/* Auto refresh events */}
          <div>
            <div style={{ fontFamily: SANS_FONT, fontSize: 11, fontWeight: 500, color: COLORS.textSecondary, marginBottom: 4 }}>Auto Refresh Events</div>
            <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted, marginBottom: 8 }}>
              Toggle which events trigger automatic context doc regeneration. Changes save automatically.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px" }}>
              {EVENT_TOGGLES.map((toggle) => {
                const checked = !!events[toggle.key];
                return (
                  <label
                    key={toggle.key}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      cursor: "pointer",
                      padding: "6px 8px",
                      borderRadius: 8,
                      border: `1px solid ${checked ? COLORS.accentBorder : "transparent"}`,
                      background: checked ? COLORS.accentSubtle : "transparent",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleEvent(toggle.key)}
                      style={{ marginTop: 2, accentColor: COLORS.accent }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textPrimary }}>{toggle.label}</div>
                      <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textMuted, lineHeight: 1.3 }}>{toggle.help}</div>
                    </div>
                  </label>
                );
              })}
            </div>
            <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, marginTop: 8 }}>
              Higher frequency can increase token usage and cost. Use lightweight models for aggressive cadences.
            </div>
          </div>

          {/* Generate button + status */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              type="button"
              style={primaryButton({ height: 32, padding: "0 16px", fontSize: 12, borderRadius: 10 })}
              disabled={generating || !modelId.trim()}
              onClick={() => void handleGenerate()}
            >
              {generating ? "Generating..." : "Generate Now"}
            </button>

            {genResult ? (
              <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.success }}>{genResult}</div>
            ) : null}
            {genError ? (
              <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.danger, maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{genError}</div>
            ) : null}
          </div>
        </div>
      </section>

      <SkillFilesSection />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Skill Files Section
   ═══════════════════════════════════════════════════════════════════════════ */

function SkillFilesSection() {
  const [skills, setSkills] = React.useState<SkillIndexEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [reindexing, setReindexing] = React.useState(false);

  const loadSkills = React.useCallback(async () => {
    setLoading(true);
    try {
      const entries = await window.ade.memory?.listIndexedSkills?.() ?? [];
      setSkills(entries);
    } catch {
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const handleReindex = React.useCallback(async () => {
    setReindexing(true);
    try {
      const entries = await window.ade.memory?.reindexSkills?.({}) ?? [];
      setSkills(entries);
    } catch {
      /* ignore — list stays as-is */
    } finally {
      setReindexing(false);
    }
  }, []);

  return (
    <section>
      <div style={sectionLabelStyle}>Skill Files</div>
      <div style={{ ...cardStyle({ padding: 16 }), display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary, flex: 1, minWidth: 0 }}>
            Reusable instruction files that AI agents can reference. Scanned from .ade/skills/, .claude/skills/, .claude/commands/, CLAUDE.md, and agents.md.
          </div>
          <button
            type="button"
            style={outlineButton({ height: 28, padding: "0 10px", fontSize: 10, borderRadius: 8, flexShrink: 0 })}
            disabled={reindexing}
            onClick={() => { void handleReindex(); }}
          >
            {reindexing ? "Reindexing\u2026" : "Reindex"}
          </button>
        </div>

        {loading ? (
          <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>Loading skill files...</div>
        ) : skills.length === 0 ? (
          <EmptyState title="No skill files found" description="Add .md files to .ade/skills/ or .claude/skills/ to get started." />
        ) : (
          skills.map((skill) => (
            <div
              key={skill.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                border: `1px solid ${COLORS.border}`,
                background: COLORS.recessedBg,
                borderRadius: 10,
                padding: "10px 12px",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                <div
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 12,
                    color: COLORS.textPrimary,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {skill.path}
                </div>
                <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textSecondary }}>
                  {skill.kind} &middot; {skill.source} &middot; {relativeTime(skill.lastModifiedAt ?? skill.updatedAt)}
                </div>
              </div>
              <button
                type="button"
                style={outlineButton({ height: 26, padding: "0 10px", fontSize: 10, borderRadius: 8, flexShrink: 0 })}
                onClick={() => {
                  void window.ade.app.revealPath(skill.path).catch(() => {});
                }}
              >
                Reveal
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
