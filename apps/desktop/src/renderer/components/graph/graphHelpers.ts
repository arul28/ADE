import React from "react";
import { Flag, Lightning, Shield, Star, Tag } from "@phosphor-icons/react";
import type {
  ConflictStatus,
  GraphStatusFilter,
  GraphViewMode,
  IntegrationProposal,
  LaneIcon,
  LaneSummary
} from "../../../shared/types";
import type { GraphEdgeData, GraphNodeData, GraphPrOverlay } from "./graphTypes";

export const VIEW_MODES: GraphViewMode[] = ["stack", "risk", "activity", "all"];

export const ICON_OPTIONS: Array<{ key: LaneIcon; label: string; icon: React.ReactNode }> = [
  { key: null, label: "None", icon: React.createElement("span", { className: "text-xs" }, "\u25CB") },
  { key: "star", label: "Star", icon: React.createElement(Star, { size: 14, weight: "regular" }) },
  { key: "flag", label: "Flag", icon: React.createElement(Flag, { size: 14, weight: "regular" }) },
  { key: "bolt", label: "Bolt", icon: React.createElement(Lightning, { size: 14, weight: "regular" }) },
  { key: "shield", label: "Shield", icon: React.createElement(Shield, { size: 14, weight: "regular" }) },
  { key: "tag", label: "Tag", icon: React.createElement(Tag, { size: 14, weight: "regular" }) }
];

export const COLOR_PALETTE = ["#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#2563eb", "#9333ea", "#1f2937", "#f8fafc"];

export const DEFAULT_PRESET = "__default__";

export const BATCH_OPERATION_LABELS: Record<string, string> = {
  restack: "Rebase",
  restack_publish: "Restack + Publish",
  push: "Push",
  fetch: "Fetch",
  archive: "Archive",
  delete: "Delete",
  sync: "Pull"
};

export function batchOperationLabel(operation: string): string {
  return BATCH_OPERATION_LABELS[operation] ?? operation;
}

export function edgePairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

export function proposalSourceLaneIds(proposal: IntegrationProposal): string[] {
  const sourceLaneIds = (proposal as { sourceLaneIds?: unknown }).sourceLaneIds;
  if (!Array.isArray(sourceLaneIds)) return [];
  return sourceLaneIds.filter((laneId): laneId is string => typeof laneId === "string");
}

export function proposalSteps(proposal: IntegrationProposal): IntegrationProposal["steps"] {
  const steps = (proposal as { steps?: unknown }).steps;
  return Array.isArray(steps) ? (steps as IntegrationProposal["steps"]) : [];
}

export function proposalLaneSummaries(proposal: IntegrationProposal): IntegrationProposal["laneSummaries"] {
  const laneSummaries = (proposal as { laneSummaries?: unknown }).laneSummaries;
  return Array.isArray(laneSummaries) ? (laneSummaries as IntegrationProposal["laneSummaries"]) : [];
}

export function proposalPairwiseResults(proposal: IntegrationProposal): IntegrationProposal["pairwiseResults"] {
  const pairwiseResults = (proposal as { pairwiseResults?: unknown }).pairwiseResults;
  return Array.isArray(pairwiseResults) ? (pairwiseResults as IntegrationProposal["pairwiseResults"]) : [];
}

export function laneSummaryConflictsWith(laneSummary: IntegrationProposal["laneSummaries"][number]): string[] {
  const conflictsWith = (laneSummary as { conflictsWith?: unknown }).conflictsWith;
  if (!Array.isArray(conflictsWith)) return [];
  return conflictsWith.filter((laneId): laneId is string => typeof laneId === "string");
}

export function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  if (setA.size !== b.length) return false;
  for (const id of b) {
    if (!setA.has(id)) return false;
  }
  return true;
}

export function toRelativeTime(iso: string | null): string {
  if (!iso) return "No recent activity";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "No recent activity";
  const delta = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "active just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function laneStatusGroup(status: ConflictStatus["status"] | undefined): GraphStatusFilter {
  if (status === "conflict-active" || status === "conflict-predicted") return "conflict";
  if (status === "behind-base") return "at-risk";
  if (status === "merge-ready") return "clean";
  return "unknown";
}

export function riskStrokeColor(level: GraphEdgeData["riskLevel"]): string {
  if (level === "high") return "#dc2626";
  if (level === "medium") return "#f59e0b";
  if (level === "low") return "#16a34a";
  return "#6b7280";
}

export function proposalOutcomeColor(outcome: GraphNodeData["proposalOutcome"]): string {
  if (outcome === "blocked") return "#EF4444";
  if (outcome === "conflict") return "#F59E0B";
  return "#22C55E";
}

export function prOverlayColor(pr: GraphPrOverlay): string {
  if (pr.state === "draft") return "#a855f7";
  if (pr.checksStatus === "failing") return "#dc2626";
  if (pr.reviewStatus === "changes_requested") return "#f59e0b";
  if (pr.checksStatus === "passing") return "#16a34a";
  if (pr.checksStatus === "pending") return "#38bdf8";
  return "#6b7280";
}

export function prCiDotColor(pr: GraphPrOverlay): string {
  if (pr.checksStatus === "failing") return "#dc2626";
  if (pr.checksStatus === "passing") return "#16a34a";
  if (pr.checksStatus === "pending") return "#f59e0b";
  return "#6b7280";
}

export function iconGlyph(icon: LaneIcon): React.ReactNode {
  if (icon === "star") return React.createElement(Star, { size: 14, weight: "regular" });
  if (icon === "flag") return React.createElement(Flag, { size: 14, weight: "regular" });
  if (icon === "bolt") return React.createElement(Lightning, { size: 14, weight: "regular" });
  if (icon === "shield") return React.createElement(Shield, { size: 14, weight: "regular" });
  if (icon === "tag") return React.createElement(Tag, { size: 14, weight: "regular" });
  return null;
}

export function nodeDimensions(lane: LaneSummary, bucket: GraphNodeData["activityBucket"], mode: GraphViewMode): { width: number; height: number } {
  if (mode === "activity") {
    if (bucket === "min") return { width: 100, height: 50 };
    if (bucket === "low") return { width: 130, height: 65 };
    if (bucket === "high") return { width: 200, height: 100 };
    return { width: 160, height: 80 };
  }
  if (lane.laneType === "primary") return { width: 200, height: 100 };
  return { width: 160, height: 80 };
}

export function branchNameFromRef(ref: string): string {
  const trimmed = (ref ?? "").trim();
  if (trimmed.startsWith("refs/heads/")) return trimmed.slice("refs/heads/".length);
  return trimmed;
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExp(glob: string): RegExp {
  const parts = glob.split("*").map(escapeRegex);
  return new RegExp(`^${parts.join(".*")}$`);
}

export function collectDescendants(lanes: LaneSummary[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const lane of lanes) {
    if (!lane.parentLaneId) continue;
    const list = childrenByParent.get(lane.parentLaneId) ?? [];
    list.push(lane.id);
    childrenByParent.set(lane.parentLaneId, list);
  }
  const out = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenByParent.get(current) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

export function isIntegrationLane(lane: LaneSummary): boolean {
  return (
    (lane.description != null && lane.description.includes("Integration lane")) ||
    lane.name.startsWith("integration/")
  );
}
