import { useEffect, useMemo, useRef, useState } from "react";
import { COLORS } from "../../lanes/laneDesignTokens";
import { Backdrop, SEARCH_PANEL_SURFACE as PANEL } from "./FilesSearchPanel";

export type PromptKind = "file" | "directory";

/** Inline name prompt for creating a file or folder (Electron blocks window.prompt). */
export function CreatePromptModal({
  kind,
  baseDir,
  onClose,
  onSubmit,
}: {
  kind: PromptKind;
  baseDir: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const error = useMemo(() => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    if (/[\\/]/.test(trimmed) || trimmed === "." || trimmed === "..") return "Invalid name";
    return null;
  }, [name]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || error) return;
    onSubmit(trimmed);
    onClose();
  };

  return (
    <Backdrop onClose={onClose}>
      <div style={{ ...PANEL, width: 420, maxWidth: "90%" }}>
        <div className="px-3 py-2 text-xs" style={{ borderBottom: `1px solid ${COLORS.border}`, color: COLORS.textMuted }}>
          New {kind === "file" ? "file" : "folder"}{baseDir ? ` in ${baseDir}/` : " in workspace root"}
        </div>
        <div className="p-3">
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder={kind === "file" ? "name.ext" : "folder-name"}
            className="w-full rounded border bg-transparent px-2 py-1 text-sm outline-none"
            style={{ borderColor: error ? COLORS.danger : COLORS.outlineBorder, color: COLORS.textPrimary }}
          />
          {error ? <div className="mt-1 text-xs" style={{ color: COLORS.danger }}>{error}</div> : null}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded px-3 py-1 text-xs" style={{ color: COLORS.textMuted }}>
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!name.trim() || !!error}
              className="rounded px-3 py-1 text-xs disabled:opacity-40"
              style={{ background: COLORS.accent, color: "var(--color-accent-fg)" }}
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </Backdrop>
  );
}
