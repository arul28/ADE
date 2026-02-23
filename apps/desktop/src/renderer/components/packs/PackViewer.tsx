import React, { useEffect, useRef, useState } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import type { PackSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { useNavigate } from "react-router-dom";

type PackScope = "lane" | "project";

const scopeTrigger =
  "inline-flex items-center justify-center rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors";

const INTERNAL_PACK_MARKER_RE = /^\s*<!--\s*ADE_[A-Z0-9_:-]+\s*-->\s*$/gm;
const JSON_FENCE_RE = /^```json\s*\n([\s\S]*?)\n```/m;

function stripInternalPackMarkers(body: string): string {
  return body.replace(INTERNAL_PACK_MARKER_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function extractJsonHeader(body: string): Record<string, unknown> | null {
  const match = body.match(JSON_FENCE_RE);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function stripJsonFence(body: string): string {
  return body.replace(JSON_FENCE_RE, "").trimStart();
}

function relativeTime(ts: string | null | undefined): string {
  if (!ts) return "never";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

// Parse markdown sections into structured blocks for rich rendering
type PackSection = {
  heading: string;
  level: number;
  content: string;
  lines: string[];
};

function parseMarkdownSections(body: string): PackSection[] {
  const lines = body.split("\n");
  const sections: PackSection[] = [];
  let current: PackSection | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      if (current) sections.push(current);
      current = {
        heading: headingMatch[2].trim(),
        level: headingMatch[1].length,
        content: "",
        lines: []
      };
    } else if (current) {
      current.lines.push(line);
      current.content += line + "\n";
    } else {
      // Content before any heading
      if (line.trim()) {
        if (!current) {
          current = { heading: "", level: 0, content: "", lines: [] };
        }
        current.lines.push(line);
        current.content += line + "\n";
      }
    }
  }
  if (current) sections.push(current);
  return sections;
}

// Detect if a section contains a markdown table
function isTable(lines: string[]): boolean {
  return lines.some((l) => l.includes("|") && l.includes("---"));
}

function renderMarkdownTable(lines: string[]) {
  const tableLines = lines.filter((l) => l.trim().startsWith("|"));
  if (tableLines.length < 2) return null;

  const parseRow = (line: string) =>
    line.split("|").map((cell) => cell.trim()).filter(Boolean);

  const headers = parseRow(tableLines[0]);
  const isSeparator = (line: string) => /^\|[\s-:|]+\|$/.test(line.trim());
  const dataLines = tableLines.filter((l) => !isSeparator(l)).slice(1);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-border/40">
            {headers.map((h, i) => (
              <th key={i} className="px-2 py-1.5 text-left font-semibold text-muted-fg">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataLines.map((line, i) => {
            const cells = parseRow(line);
            return (
              <tr key={i} className="border-b border-border/20 hover:bg-muted/20">
                {cells.map((cell, j) => (
                  <td key={j} className="px-2 py-1.5 text-fg/80">{cell}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function renderSectionContent(section: PackSection) {
  const trimmedLines = section.lines.filter((l) => l.trim());
  if (!trimmedLines.length) return null;

  // Render tables with proper styling
  if (isTable(trimmedLines)) {
    const nonTableLines = trimmedLines.filter((l) => !l.includes("|") || !l.includes("---"));
    const tableContent = renderMarkdownTable(trimmedLines);
    const textContent = nonTableLines.filter((l) => !l.trim().startsWith("|")).join("\n").trim();
    return (
      <div className="space-y-2">
        {textContent ? <div className="text-xs text-fg/80 whitespace-pre-wrap">{textContent}</div> : null}
        {tableContent}
      </div>
    );
  }

  // Render list items with bullets
  const hasListItems = trimmedLines.some((l) => /^\s*[-*]\s/.test(l));
  if (hasListItems) {
    return (
      <ul className="space-y-1 text-xs text-fg/80">
        {trimmedLines.map((line, i) => {
          const listMatch = line.match(/^\s*[-*]\s+(.*)/);
          if (listMatch) {
            return (
              <li key={i} className="flex gap-2">
                <span className="text-accent/60 shrink-0">-</span>
                <span>{listMatch[1]}</span>
              </li>
            );
          }
          return <li key={i} className="pl-4">{line}</li>;
        })}
      </ul>
    );
  }

  // Default: render as preformatted text
  return (
    <div className="text-xs text-fg/80 whitespace-pre-wrap leading-relaxed">
      {section.content.trim()}
    </div>
  );
}

function JsonHeaderCard({ header }: { header: Record<string, unknown> }) {
  const entries = Object.entries(header).filter(
    ([key]) => !["schema", "contractVersion"].includes(key)
  );
  if (!entries.length) return null;

  return (
    <div className="rounded-lg border border-border/30 bg-card/30 p-3">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
        {entries.slice(0, 12).map(([key, value]) => (
          <div key={key} className="flex gap-2 overflow-hidden">
            <span className="font-medium text-muted-fg shrink-0">{key}:</span>
            <span className="text-fg/80 truncate">
              {typeof value === "object" ? JSON.stringify(value) : String(value ?? "-")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ParsedPackBody({ pack }: { pack: PackSummary | null }) {
  if (!pack) return <div className="text-xs text-muted-fg">Loading…</div>;
  if (!pack.exists || !pack.body.trim().length) {
    return <div className="text-xs text-muted-fg">Pack file not created yet.</div>;
  }

  let body = stripInternalPackMarkers(pack.body);
  const header = extractJsonHeader(body);
  body = stripJsonFence(body);
  const sections = parseMarkdownSections(body);

  return (
    <div className="space-y-3 max-h-[580px] overflow-auto">
      {header ? <JsonHeaderCard header={header} /> : null}
      {sections.map((section, i) => (
        <div key={i}>
          {section.heading ? (
            <h3 className={cn(
              "font-semibold text-fg mb-1.5",
              section.level <= 2 ? "text-sm" : "text-xs"
            )}>
              {section.heading}
            </h3>
          ) : null}
          {renderSectionContent(section)}
        </div>
      ))}
    </div>
  );
}

export function PackViewer({ laneId }: { laneId: string | null }) {
  const navigate = useNavigate();

  const [scope, setScope] = useState<PackScope>("lane");
  const [lanePack, setLanePack] = useState<PackSummary | null>(null);
  const [projectPack, setProjectPack] = useState<PackSummary | null>(null);

  const [refreshBusy, setRefreshBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activePack = scope === "project" ? projectPack : lanePack;

  const refreshTimers = useRef<{ lane?: number | null; project?: number | null }>({});

  const fetchLanePack = async () => {
    if (!laneId) return;
    const pack = await window.ade.packs.getLanePack(laneId);
    setLanePack(pack);
  };

  const fetchProjectPack = async () => {
    const pack = await window.ade.packs.getProjectPack();
    setProjectPack(pack);
  };

  const scheduleLaneFetch = () => {
    if (!laneId) return;
    if (refreshTimers.current.lane) window.clearTimeout(refreshTimers.current.lane);
    refreshTimers.current.lane = window.setTimeout(() => {
      refreshTimers.current.lane = null;
      fetchLanePack().catch(() => {});
    }, 120);
  };

  const scheduleProjectFetch = () => {
    if (refreshTimers.current.project) window.clearTimeout(refreshTimers.current.project);
    refreshTimers.current.project = window.setTimeout(() => {
      refreshTimers.current.project = null;
      fetchProjectPack().catch(() => {});
    }, 120);
  };

  const refreshCombined = async () => {
    setRefreshBusy(true);
    setError(null);
    try {
      if (scope === "project") {
        const pack = await window.ade.packs.refreshProjectPack({ laneId });
        setProjectPack(pack);
      } else {
        if (!laneId) return;
        const pack = await window.ade.packs.refreshLanePack(laneId);
        setLanePack(pack);
        await fetchProjectPack().catch(() => {});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshBusy(false);
    }
  };

  useEffect(() => {
    setLanePack(null);
    setProjectPack(null);
    setError(null);
    if (laneId) fetchLanePack().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    fetchProjectPack().catch(() => setProjectPack(null));
  }, [laneId]);

  useEffect(() => {
    if (!laneId) return;
    const lanePackKey = `lane:${laneId}`;
    const unsub = window.ade.packs.onEvent((ev) => {
      if (ev.packKey === lanePackKey && ev.eventType === "refresh_triggered") {
        scheduleLaneFetch();
      }
      if (ev.packKey === "project" && ev.eventType === "refresh_triggered") {
        scheduleProjectFetch();
      }
    });
    return () => {
      try { unsub(); } catch { /* ignore */ }
    };
  }, [laneId]);

  if (!laneId && scope === "lane") {
    return <EmptyState title="No lane selected" description="Select a lane to view its pack." />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-border/40 bg-card/50 p-0.5">
            <button
              type="button"
              className={cn(scopeTrigger, scope === "lane" ? "bg-muted text-fg shadow-sm border border-accent/40" : "text-muted-fg hover:bg-muted/50 hover:text-fg border border-transparent")}
              onClick={() => setScope("lane")}
              title="Lane pack"
            >
              Lane
            </button>
            <button
              type="button"
              className={cn(scopeTrigger, scope === "project" ? "bg-muted text-fg shadow-sm border border-accent/40" : "text-muted-fg hover:bg-muted/50 hover:text-fg border border-transparent")}
              onClick={() => setScope("project")}
              title="Project pack"
            >
              Project
            </button>
          </div>
          <div className="text-xs text-muted-fg">
            Updated {relativeTime(activePack?.deterministicUpdatedAt)}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" title="Refresh pack" onClick={() => refreshCombined().catch(() => {})} disabled={refreshBusy}>
            <ArrowsClockwise size={16} weight="regular" className={cn(refreshBusy && "animate-spin")} />
            {refreshBusy ? "Refreshing" : "Refresh"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => navigate("/settings")}>
            Context
          </Button>
        </div>
      </div>

      {error ? <div className="rounded-lg bg-red-500/10 p-2 text-xs text-red-300">{error}</div> : null}

      <ParsedPackBody pack={activePack} />
      {activePack?.path ? <div className="truncate text-[11px] text-muted-fg mt-1">{activePack.path}</div> : null}
    </div>
  );
}
