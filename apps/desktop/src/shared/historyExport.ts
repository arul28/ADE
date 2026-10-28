import type { ExportHistoryArgs, OperationRecord } from "./types/git";

export type HistoryExportFormat = "csv" | "json";

/** The History export file, built the same way on desktop and on the web client. */
export function buildHistoryExport(args: {
  format: HistoryExportFormat;
  rows: OperationRecord[];
  exportedAt: string;
  project: { rootPath: string; displayName: string };
  filters: { laneId?: string; kind?: string; status?: ExportHistoryArgs["status"] };
}): { content: string; fileName: string } {
  const { format, rows, exportedAt, project, filters } = args;
  const projectSlug = project.displayName.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const fileName = `ade-history-${projectSlug}-${exportedAt.slice(0, 10)}.${format}`;
  if (format === "json") {
    const content = `${JSON.stringify(
      {
        exportedAt,
        project,
        filters: {
          laneId: filters.laneId ?? null,
          kind: filters.kind ?? null,
          status: filters.status ?? "all",
        },
        rowCount: rows.length,
        rows,
      },
      null,
      2,
    )}\n`;
    return { content, fileName };
  }
  const columns = [
    "id",
    "laneId",
    "laneName",
    "kind",
    "status",
    "startedAt",
    "endedAt",
    "preHeadSha",
    "postHeadSha",
    "metadataJson",
  ] as const;
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvCell(row[column] == null ? "" : String(row[column]))).join(","));
  }
  return { content: `${lines.join("\n")}\n`, fileName };
}

function escapeCsvCell(value: string): string {
  // A cell starting with = + - @ runs as a formula in a spreadsheet; a lane
  // name is user text, so it is kept literal with a leading apostrophe.
  const cell = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, "\"\"")}"` : cell;
}
