import React from "react";
import { RefreshCw, Save, Trash2 } from "lucide-react";
import type { KeybindingDefinition, KeybindingOverride, KeybindingsSnapshot } from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";

type DraftRow = {
  id: string;
  binding: string;
};

function effectiveBinding(def: KeybindingDefinition, overrides: Map<string, string>): string {
  return overrides.get(def.id) ?? def.defaultBinding;
}

export function KeybindingsSection() {
  const [snapshot, setSnapshot] = React.useState<KeybindingsSnapshot | null>(null);
  const [draft, setDraft] = React.useState<Map<string, string>>(new Map());
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.ade.keybindings.get();
      setSnapshot(next);
      setDraft(new Map((next.overrides ?? []).map((o) => [o.id, o.binding] as const)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async () => {
    if (!snapshot) return;
    setSaving(true);
    setError(null);
    try {
      const overrides: KeybindingOverride[] = Array.from(draft.entries())
        .map(([id, binding]) => ({ id, binding: binding.trim() }))
        .filter((o) => o.binding.length > 0);
      const next = await window.ade.keybindings.set(overrides);
      setSnapshot(next);
      setDraft(new Map((next.overrides ?? []).map((o) => [o.id, o.binding] as const)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const clearOverrides = async () => {
    setDraft(new Map());
    try {
      const next = await window.ade.keybindings.set([]);
      setSnapshot(next);
    } catch {
      // ignore
    }
  };

  const defs = React.useMemo(() => {
    const list = snapshot?.definitions ?? [];
    return [...list].sort((a, b) => {
      const scopeDelta = a.scope.localeCompare(b.scope);
      if (scopeDelta !== 0) return scopeDelta;
      return a.id.localeCompare(b.id);
    });
  }, [snapshot]);

  return (
    <section className="rounded-lg border border-border bg-card/70 p-3 md:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Keybindings</div>
          <div className="mt-0.5 text-xs text-muted-fg">
            Overrides use a simple comma-separated format like <span className="font-mono">Mod+K</span> or{" "}
            <span className="font-mono">J,ArrowDown</span>. (Binding application is incremental; some areas still use defaults.)
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            Refresh
          </Button>
          <Button size="sm" disabled={saving || !snapshot} onClick={() => void save()}>
            <Save className="h-4 w-4" />
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button size="sm" variant="outline" disabled={!snapshot} onClick={() => void clearOverrides()}>
            <Trash2 className="h-4 w-4" />
            Reset
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mt-2 rounded border border-red-900 bg-red-950/20 p-2 text-xs text-red-300">{error}</div>
      ) : null}

      {!snapshot ? (
        <div className="mt-3 rounded border border-border bg-bg/40 p-3 text-xs text-muted-fg">Loading keybindings…</div>
      ) : (
        <div className="mt-3 overflow-auto rounded border border-border bg-bg/40">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-bg/90 backdrop-blur">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-semibold text-fg">Action</th>
                <th className="px-3 py-2 font-semibold text-fg">Scope</th>
                <th className="px-3 py-2 font-semibold text-fg">Default</th>
                <th className="px-3 py-2 font-semibold text-fg">Override</th>
                <th className="px-3 py-2 font-semibold text-fg">Effective</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {defs.map((def) => {
                const override = draft.get(def.id) ?? "";
                const effective = effectiveBinding(def, draft);
                return (
                  <tr key={def.id}>
                    <td className="px-3 py-2">
                      <div className="font-semibold text-fg">{def.description}</div>
                      <div className="mt-0.5 text-[11px] text-muted-fg font-mono">{def.id}</div>
                    </td>
                    <td className="px-3 py-2 text-muted-fg">{def.scope}</td>
                    <td className="px-3 py-2 font-mono text-muted-fg">{def.defaultBinding}</td>
                    <td className="px-3 py-2">
                      <input
                        className="h-8 w-full rounded border border-border bg-card/60 px-2 text-xs font-mono"
                        placeholder="(empty)"
                        value={override}
                        onChange={(e) =>
                          setDraft((prev) => {
                            const next = new Map(prev);
                            const value = e.target.value;
                            if (!value.trim().length) next.delete(def.id);
                            else next.set(def.id, value);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-fg">{effective}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

