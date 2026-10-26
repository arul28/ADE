import { Lock } from "@phosphor-icons/react";
import { modelMentionEffortLabel, modelMentionPermissionLabel } from "../../../shared/modelMentions";
import type { ComputerUseArtifactView } from "../../../shared/types";
import { isImageArtifact, useArtifactPreview } from "./useArtifactPreview";

export type ExtraChipCardData =
  | { kind: "commit"; subject: string; author: string; age: string; lane: string }
  | { kind: "terminal"; title: string; lane: string; tool: string; status: string; startedAt: string }
  | { kind: "model"; name: string; route: string; effort: string | null; permission: string | null; provider: string }
  | { kind: "permission"; meaning: string; risk: "low" | "medium" | "high" }
  | { kind: "skill"; name: string; description: string | null; source: string; argumentHint: string | null }
  | { kind: "branch"; name: string; lane: string; pullRequest: string | null }
  | { kind: "artifact"; artifact: ComputerUseArtifactView; artifactKind: string; createdAt: string }
  /** A settings chip: where it is, whether only you may change it, and whether this window can open it. */
  | { kind: "setting"; path: string; ownerOnly: string | null; locked: boolean; unavailable: string | null };

export function ExtraChipCardBody({ data }: { data: ExtraChipCardData }) {
  if (data.kind === "artifact") return <ArtifactCardBody data={data} />;
  if (data.kind === "setting") {
    return <div className="max-w-[260px] text-[11px] text-fg/65">
      <div className="text-[12px] font-medium text-fg/90">{data.path}</div>
      {data.ownerOnly ? (
        <div className={`mt-1 flex gap-1 ${data.locked ? "text-amber-200/90" : ""}`}>
          {data.locked ? <Lock size={11} weight="bold" className="mt-[2px] shrink-0" aria-hidden /> : null}
          <span>Only you can change this. {data.ownerOnly}</span>
        </div>
      ) : null}
      {data.unavailable ? <div className="mt-1">{data.unavailable}</div> : null}
    </div>;
  }
  if (data.kind === "commit") {
    return <div className="max-w-[260px] text-[11px] text-fg/65">
      <div className="line-clamp-2 text-[12px] font-medium text-fg/90">{data.subject}</div>
      <div className="truncate">{data.author} · {data.age}</div>
      <div className="truncate">{data.lane}</div>
    </div>;
  }
  if (data.kind === "terminal") {
    return <div className="max-w-[240px] text-[11px] text-fg/65">
      <div className="truncate text-[12px] font-medium text-fg/90">{data.title}</div>
      <div className="truncate">{data.lane} · {data.tool} · {data.status}</div>
      <div>Started {data.startedAt}</div>
    </div>;
  }
  if (data.kind === "model") {
    return <div className="max-w-[240px] text-[11px] text-fg/65">
      <div className="truncate text-[12px] font-medium text-fg/90">{data.name}</div>
      <div className="truncate">{data.route} · {data.provider}</div>
      <div className="truncate">Effort {modelMentionEffortLabel(data.effort)} · {modelMentionPermissionLabel(data.permission, data.provider)}</div>
    </div>;
  }
  if (data.kind === "permission") {
    const tone = data.risk === "high" ? "text-rose-300" : data.risk === "medium" ? "text-amber-300" : "text-emerald-300";
    return <div className={`max-w-[240px] text-[11px] ${tone}`}>{data.meaning}</div>;
  }
  if (data.kind === "branch") {
    return <div className="max-w-[240px] text-[11px] text-fg/65">
      <div className="truncate font-mono text-[12px] font-medium text-fg/90">{data.name}</div>
      <div className="truncate">{data.lane}{data.pullRequest ? ` · ${data.pullRequest}` : ""}</div>
    </div>;
  }
  return <div className="max-w-[240px] text-[11px] text-fg/65">
    <div className="truncate text-[12px] font-medium text-fg/90">/{data.name}{data.argumentHint ? ` ${data.argumentHint}` : ""}</div>
    {data.description ? <div className="line-clamp-2">{data.description}</div> : null}
    <div>{data.source}</div>
  </div>;
}

function ArtifactCardBody({ data }: { data: Extract<ExtraChipCardData, { kind: "artifact" }> }) {
  const { containerRef, preview, onMediaError } = useArtifactPreview<HTMLDivElement>(data.artifact, false);
  return <div ref={containerRef} className="w-[220px]">
    {preview && isImageArtifact(data.artifact) ? <img src={preview} alt="" draggable={false} onError={onMediaError} className="mb-1.5 aspect-video w-full rounded-md object-cover" /> : null}
    <div className="truncate text-[12px] font-medium text-fg/90">{data.artifact.title}</div>
    <div className="truncate text-[11px] text-fg/55">{data.artifactKind} · {data.createdAt}</div>
  </div>;
}
