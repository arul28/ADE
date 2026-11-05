import type { ComputerUseProofProvenanceInput } from "../../../shared/types/computerUseArtifacts";

/*
 * Files an Android capture (a screenshot, a recording, a render) in the proof
 * drawer, the way the Apple device files its own (`fileScreenshotAsProof` in
 * `iosSimulatorService.ts`).
 *
 * The owners are the calling chat and the lane. A capture from the CLI has no
 * chat, so the lane alone owns it; with no owner at all the drawer would keep
 * a row that no scope lists.
 *
 * A filing never fails the capture: the file on disk is what was asked for.
 * A caller on another machine sends `proof: false` and files the bytes it
 * reads back in its own drawer (`cliMachineTargeting.ts`), so nothing here
 * runs for it.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** The slice of the proof broker an Android service needs. Narrow, so tests need no database. */
export type AndroidArtifactFiler = {
  ingest(request: {
    backend: { name: string; style?: string | null; toolName?: string | null };
    inputs: Array<Record<string, unknown>>;
    owners?: Array<{ kind: string; id: string }>;
    callerRoot?: string | null;
    provenance?: ComputerUseProofProvenanceInput | null;
  }): unknown;
};

/** The broker's backend name for everything the Android emulator files. */
export const ANDROID_PROOF_BACKEND_NAME = "android-emulator";

export type AndroidCaptureProofInput = {
  laneId: string;
  /** The calling chat; null for a CLI caller with no chat. */
  chatSessionId: string | null;
  kind: "screenshot" | "video_recording";
  path: string;
  mimeType: string;
  title: string;
  description: string;
  /** `android_screenshot`, `android_record`, `android_render`. */
  toolName: string;
  /** ADE made these bytes: a capture, or a recording. */
  source: "ade-capture" | "ade-recorder";
  metadata?: Record<string, unknown>;
  /** The lane's folder, so the broker places the row by path too. */
  callerRoot?: string | null;
};

/** The artifact id an `ingest` returned, or null. Read defensively: tests pass a two-line fake filer. */
function readArtifactId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const artifacts = (result as { artifacts?: unknown }).artifacts;
  const first = Array.isArray(artifacts) ? artifacts[0] : null;
  if (!first || typeof first !== "object") return null;
  for (const key of ["artifactId", "id"]) {
    const value = (first as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Files one capture and answers its artifact id, or null when there is no
 * drawer or the drawer refused it. Never throws.
 */
export function fileAndroidCaptureAsProof(
  filer: AndroidArtifactFiler | null | undefined,
  input: AndroidCaptureProofInput,
  onError?: (error: unknown) => void,
): string | null {
  if (!filer) return null;
  const chatSessionId = input.chatSessionId?.trim() || null;
  const owners: Array<{ kind: "chat_session" | "lane"; id: string }> = [
    ...(chatSessionId ? [{ kind: "chat_session" as const, id: chatSessionId }] : []),
    ...(input.laneId ? [{ kind: "lane" as const, id: input.laneId }] : []),
  ];
  try {
    const result = filer.ingest({
      backend: { name: ANDROID_PROOF_BACKEND_NAME, style: "local_fallback", toolName: input.toolName },
      ...(owners.length ? { owners } : {}),
      ...(input.callerRoot ? { callerRoot: input.callerRoot } : {}),
      provenance: { source: input.source },
      inputs: [{
        kind: input.kind,
        title: input.title,
        description: input.description,
        path: input.path,
        mimeType: input.mimeType,
        metadata: { laneId: input.laneId, ...(input.metadata ?? {}) },
      }],
    });
    return readArtifactId(result);
  } catch (error) {
    onError?.(error);
    return null;
  }
}
