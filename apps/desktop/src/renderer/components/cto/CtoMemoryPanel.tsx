import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import type { CtoMemorySnapshot } from "../../../shared/types";
import { cn } from "../ui/cn";

const MONO_TEXTAREA =
  "w-full rounded-lg border border-white/[0.08] bg-black/30 p-3 font-mono text-[11.5px] leading-5 text-fg/85 placeholder:text-muted-fg/35 focus:border-white/20 focus:outline-none resize-y";

/**
 * The CTO's durable memory: an editable MEMORY.md, a read-only rolling thread
 * state, and today's collapsed activity log. These are the files the CTO reads
 * back on every model switch and after compaction.
 */
export function CtoMemoryPanel() {
  const [snapshot, setSnapshot] = useState<CtoMemorySnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  const load = useCallback(async () => {
    const bridge = window.ade?.cto;
    if (!bridge?.getMemory) {
      setLoading(false);
      return;
    }
    try {
      const next = await bridge.getMemory();
      setSnapshot(next);
      setDraft(next.memory);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load memory.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = snapshot != null && draft !== snapshot.memory;

  const handleSave = useCallback(async () => {
    const bridge = window.ade?.cto;
    if (!bridge?.updateMemory) return;
    setSaving(true);
    setError(null);
    try {
      const next = await bridge.updateMemory({ memory: draft });
      setSnapshot(next);
      setDraft(next.memory);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save memory.");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const savedRecently = useMemo(
    () => savedAt != null && Date.now() - savedAt < 4000,
    [savedAt],
  );

  if (loading) {
    return <div className="text-[12px] text-muted-fg/45">Loading memory…</div>;
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-[12.5px] font-medium text-fg/85">What the CTO remembers</div>
          <div className="flex items-center gap-2">
            {savedRecently && !dirty && (
              <span className="text-[11px] text-emerald-400/80">Saved</span>
            )}
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void handleSave()}
              className={cn(
                "h-7 rounded-lg px-3 text-[12px] font-medium transition-colors",
                dirty && !saving
                  ? "bg-white/10 text-fg hover:bg-white/[0.14]"
                  : "cursor-default bg-white/[0.04] text-muted-fg/35",
              )}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
        <textarea
          className={cn(MONO_TEXTAREA, "mt-2 min-h-[160px]")}
          value={draft}
          placeholder="# Durable facts&#10;- Decisions, preferences, and standing context the CTO should always know."
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
        />
        <div className="mt-1.5 text-[11px] leading-4 text-muted-fg/45">
          Persists across model switches and compactions. The CTO reads this back every time.
        </div>
      </div>

      {snapshot?.threadState?.trim() ? (
        <div>
          <div className="text-[12.5px] font-medium text-fg/85">Current thread state</div>
          <div className="mt-1 text-[11px] leading-4 text-muted-fg/45">
            A rolling summary the CTO rewrites as work moves. Read-only.
          </div>
          <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/25 p-3 font-mono text-[11.5px] leading-5 text-fg/70">
            {snapshot.threadState.trim()}
          </pre>
        </div>
      ) : null}

      {snapshot?.dailyLog?.trim() ? (
        <div>
          <button
            type="button"
            onClick={() => setLogOpen((v) => !v)}
            className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg/80 transition-colors hover:text-fg"
          >
            <CaretRight
              size={12}
              weight="bold"
              className={cn("text-muted-fg/50 transition-transform", logOpen && "rotate-90")}
            />
            Today's activity
            <span className="font-normal text-muted-fg/40">· {snapshot.dailyLogDate}</span>
          </button>
          {logOpen && (
            <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/25 p-3 font-mono text-[11.5px] leading-5 text-fg/65">
              {snapshot.dailyLog.trim()}
            </pre>
          )}
        </div>
      ) : null}

      {error && <div className="text-[12px] text-error">{error}</div>}
    </div>
  );
}
