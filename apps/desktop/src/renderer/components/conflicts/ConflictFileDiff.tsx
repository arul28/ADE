import React from "react";
import type { MergeSimulationResult } from "../../../shared/types";

export function ConflictFileDiff({
  result,
  selectedPath,
  onSelectPath
}: {
  result: MergeSimulationResult | null;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
}) {
  if (!result || result.conflictingFiles.length === 0) {
    return (
      <div className="rounded border border-border bg-card/60 p-3 text-xs text-muted-fg">
        No conflicting files to preview.
      </div>
    );
  }

  const current = result.conflictingFiles.find((item) => item.path === selectedPath) ?? result.conflictingFiles[0]!;

  return (
    <div className="grid min-h-[220px] grid-cols-[220px_1fr] overflow-hidden rounded border border-border bg-card/40">
      <div className="overflow-auto border-r border-border">
        {result.conflictingFiles.map((file) => {
          const selected = file.path === current.path;
          return (
            <button
              key={file.path}
              type="button"
              onClick={() => onSelectPath(file.path)}
              className={`block w-full truncate border-b border-border px-2 py-2 text-left text-xs ${
                selected ? "bg-accent/20 text-fg" : "text-muted-fg hover:bg-muted/60"
              }`}
              title={file.path}
            >
              {file.path}
            </button>
          );
        })}
      </div>
      <pre className="overflow-auto p-3 text-xs text-fg">
        {current.conflictMarkers?.trim().length
          ? current.conflictMarkers
          : `No marker preview available for ${current.path}.`}
      </pre>
    </div>
  );
}
