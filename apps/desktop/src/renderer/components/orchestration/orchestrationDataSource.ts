/**
 * orchestrationDataSource — IPC bridge helpers and asset-URL resolution
 * for the orchestration panel.
 *
 * Extracted from OrchestrationPanel.tsx to keep the panel component focused
 * on rendering. Everything here is pure logic with no React dependency.
 */

import type {
  OrchestrationEventPayload,
  OrchestrationManifest,
} from "../../../shared/types/orchestration";

/* ──────────────────────────────────────────────────────────────────────────
   Data source abstraction
   ────────────────────────────────────────────────────────────────────────── */

/** The data source lets tests inject mock bundle reads + a manual event bus.
 *  In production it's auto-derived from `window.ade.orchestration.*`. */
export type OrchestrationDataSource = {
  read: (
    args: { runId: string; laneId: string },
  ) => Promise<{ manifest: OrchestrationManifest; planMd: string; etag: string }>;
  subscribe: (
    args: { runId: string; laneId: string },
    callback: (payload: OrchestrationEventPayload) => void,
  ) => () => void;
};

export function defaultDataSource(): OrchestrationDataSource {
  return {
    read: async ({ runId, laneId }) => {
      const w = (typeof window !== "undefined" ? window : undefined) as
        | { ade?: { orchestration?: { bundleRead?: (args: { runId: string; laneId: string }) => Promise<{ manifest: OrchestrationManifest; planMd: string; etag: string }> } } }
        | undefined;
      const read = w?.ade?.orchestration?.bundleRead;
      if (!read) throw new Error("orchestration.bundleRead is not available");
      return read({ runId, laneId });
    },
    subscribe: ({ runId, laneId }, cb) => {
      const w = (typeof window !== "undefined" ? window : undefined) as
        | {
            ade?: {
              orchestration?: {
                subscribe?: (args: { runId: string; laneId?: string }, cb: (payload: OrchestrationEventPayload) => void) => () => void;
              };
            };
          }
        | undefined;
      const subscribe = w?.ade?.orchestration?.subscribe;
      if (!subscribe) return () => undefined;
      return subscribe({ runId, laneId }, cb);
    },
  };
}

/* ──────────────────────────────────────────────────────────────────────────
   Asset URL resolution
   ────────────────────────────────────────────────────────────────────────── */

export type AssetPreviewUrl = {
  url: string;
  kind: "image" | "html" | "other";
  srcDoc?: string;
};

export function assetPathKey(path: string): string {
  return path.replace(/^[/\\]+/, "");
}

export function bundleAssetFileUrl(bundleRoot: string | null | undefined, relPath: string): string | null {
  const root = (bundleRoot ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return null;
  const cleanRelPath = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = cleanRelPath.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  if (!root.startsWith("/") && !/^[A-Za-z]:\//.test(root)) return null;
  const pathname = /^[A-Za-z]:\//.test(root)
    ? `/${root}/${segments.join("/")}`
    : `${root}/${segments.join("/")}`;
  const url = new URL("file://");
  url.pathname = pathname;
  return url.toString();
}

export function assetKindForPreview(mimeType: string, relPath: string): AssetPreviewUrl["kind"] {
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.startsWith("text/html") || /\.html?$/i.test(relPath)) return "html";
  if (lowerMime.startsWith("image/")) return "image";
  return "other";
}

export async function readAssetDataUrl(args: {
  runId: string;
  laneId: string;
  relPath: string;
}): Promise<AssetPreviewUrl | null> {
  const w = (typeof window !== "undefined" ? window : undefined) as
    | {
        ade?: {
          orchestration?: {
            assetDataUrl?: (assetArgs: { runId: string; laneId: string; relPath: string }) => Promise<{
              dataUrl: string;
              mimeType: string;
              text?: string;
            }>;
          };
        };
      }
    | undefined;
  const assetDataUrl = w?.ade?.orchestration?.assetDataUrl;
  if (!assetDataUrl) return null;
  const res = await assetDataUrl(args);
  return {
    url: res.dataUrl,
    kind: assetKindForPreview(res.mimeType, args.relPath),
    ...(res.text && assetKindForPreview(res.mimeType, args.relPath) === "html" ? { srcDoc: res.text } : {}),
  };
}
