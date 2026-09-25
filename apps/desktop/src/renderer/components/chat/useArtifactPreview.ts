import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComputerUseArtifactView } from "../../../shared/types";
import {
  localArtifactMediaUrl,
  localArtifactStreamUrl,
  remoteArtifactMediaUrl,
} from "../../../shared/artifactStreamUrl";
import { playableMediaDataUrl } from "../../lib/playableMedia";
import { isWebClientMode } from "../../lib/webClientMode";
import { useChatRuntimeScope } from "./ChatRuntimeScope";

export function isImageArtifact(artifact: ComputerUseArtifactView): boolean {
  return artifact.kind === "screenshot" || (artifact.mimeType?.startsWith("image/") ?? false);
}

export function isVideoArtifact(artifact: ComputerUseArtifactView): boolean {
  return artifact.kind === "video_recording" || (artifact.mimeType?.startsWith("video/") ?? false);
}

export function externalArtifactUrl(uri: string): string | null {
  return /^https?:\/\//i.test(uri) ? uri : null;
}

/**
 * Hosts that predate availability reporting omit the field. Treat that as
 * "available" and let the preview read decide, rather than showing a broken
 * state we have no evidence for.
 */
function artifactAvailability(artifact: ComputerUseArtifactView): "available" | "missing_file" | "unimported" {
  return artifact.availability ?? "available";
}

export function isBrokenArtifact(artifact: ComputerUseArtifactView): boolean {
  return artifactAvailability(artifact) !== "available";
}

function localSourceValue(value: unknown): string | null {
  const source = typeof value === "string" ? value.trim() : "";
  return source && !externalArtifactUrl(source) ? source : null;
}

export function recoverableArtifactSource(artifact: ComputerUseArtifactView): string | null {
  return localSourceValue(artifact.metadata?.sourcePath)
    ?? localSourceValue(artifact.metadata?.sourceUri);
}

function shortSourcePath(artifact: ComputerUseArtifactView): string | null {
  const value = recoverableArtifactSource(artifact)
    ?? localSourceValue(artifact.metadata?.absolutePath);
  if (!value) return null;
  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments.length > 2 ? `…/${segments.slice(-2).join("/")}` : value;
}

/**
 * Why a preview that should exist did not load, when we know.
 *
 * `offline`: the proof is on a paired computer that is not reachable.
 * `unsent`: that computer answered but did not send the bytes.
 * `unplayable`: the bytes arrived and the browser refused them.
 */
type ArtifactPreviewFailure = "offline" | "unsent" | "unplayable";

type ArtifactPreviewProblem = {
  reason: ArtifactPreviewFailure | null;
  machineName: string;
};

function artifactMediaNoun(artifact: ComputerUseArtifactView): string {
  if (isVideoArtifact(artifact)) return "video";
  if (isImageArtifact(artifact)) return "image";
  return "file";
}

/**
 * Keep canonical storage availability separate from preview generation.
 * A missing preview can mean unsupported media or a size cap even when the
 * stored proof is intact. The generic line is only for a cause we do not know.
 */
function artifactPreviewExplanation(
  artifact: ComputerUseArtifactView,
  problem: ArtifactPreviewProblem,
): string {
  const where = shortSourcePath(artifact);
  if (artifactAvailability(artifact) === "unimported") {
    return where
      ? `Never copied into ADE's storage — it was left at ${where} in the lane it was captured in.`
      : "Never copied into ADE's storage, so there are no bytes to show.";
  }
  if (artifactAvailability(artifact) === "missing_file") {
    return "The stored file has since been deleted.";
  }
  const noun = artifactMediaNoun(artifact);
  switch (problem.reason) {
    case "offline":
      return `This ${noun} is on ${problem.machineName}, which is offline.`;
    case "unsent":
      return `${problem.machineName} could not send this ${noun}.`;
    case "unplayable":
      return noun === "video" ? "ADE could not play this video." : `ADE could not show this ${noun}.`;
    default:
      return "A preview is unavailable, but the stored proof is still attached.";
  }
}

/**
 * Where a tile's picture comes from.
 *
 * An image on this computer streams through `ade-artifact://project/`. A video
 * on this computer or on a paired one plays from main's loopback media server,
 * which answers every Range read, so a long recording loads, seeks, and costs
 * only what the player reads. Everything else, a paired machine too old to
 * stream, and a main process with no media server take the capped data URL
 * read.
 */
type ArtifactPreviewSource = "local-stream" | "remote-stream" | "data-url";

type PreviewState = {
  preview: string | null;
  source: ArtifactPreviewSource | null;
  loading: boolean;
  loaded: boolean;
  failure: ArtifactPreviewFailure | null;
};

const EMPTY_PREVIEW: PreviewState = {
  preview: null,
  source: null,
  loading: false,
  loaded: false,
  failure: null,
};

export function useArtifactPreview(
  artifact: ComputerUseArtifactView,
  allowLocalArtifactProtocol: boolean,
): {
  containerRef: React.RefObject<HTMLDivElement>;
  preview: string | null;
  loading: boolean;
  failed: boolean;
  explanation: string;
  onMediaError: () => void;
} {
  const scope = useChatRuntimeScope();
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<PreviewState>(EMPTY_PREVIEW);
  // Set once a stream failed, so the retry takes the data URL read.
  const [streamRefused, setStreamRefused] = useState(false);
  const remote = scope.binding?.kind === "remote" ? scope.binding : null;
  const targetId = remote?.targetId ?? null;
  const projectId = remote?.projectId ?? null;
  const remoteRoot = remote?.rootPath ?? null;
  const remoteOffline = scope.isRemote && !scope.online;
  const { preview, source, loading, loaded, failure } = state;

  useEffect(() => {
    const node = containerRef.current;
    if (!node || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "220px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    setState(EMPTY_PREVIEW);
    setStreamRefused(false);
  }, [artifact.id, artifact.uri]);

  // The machine came back: load again instead of keeping "is offline".
  useEffect(() => {
    if (!remoteOffline && failure === "offline") setState(EMPTY_PREVIEW);
  }, [failure, remoteOffline]);

  useEffect(() => {
    if (
      !visible
      || loaded
      || !artifact.uri
      // The host already told us there are no bytes; asking for them anyway
      // just burns an IPC round trip per tile to get null back.
      || isBrokenArtifact(artifact)
      || (!isImageArtifact(artifact) && !isVideoArtifact(artifact))
    ) return;
    const video = isVideoArtifact(artifact);
    // Images only: `protocol.handle` cannot serve the tail read a long video needs.
    const localStream = allowLocalArtifactProtocol && !video && !streamRefused
      ? localArtifactStreamUrl(artifact.uri, scope.rootPath)
      : null;
    if (localStream) {
      setState((s) => ({ ...s, preview: localStream, source: "local-stream", loaded: true }));
      return;
    }
    if (!allowLocalArtifactProtocol && remoteOffline) {
      setState((s) => ({ ...s, preview: null, failure: "offline", loaded: true }));
      return;
    }
    let cancelled = false;
    const readDataUrl = () => {
      setState((s) => ({ ...s, loading: true }));
      void window.ade.computerUse.readArtifactPreview({ uri: artifact.uri }, scope.pin)
        .then((dataUrl) => {
          if (cancelled) return;
          setState((s) => ({
            preview: playableMediaDataUrl(dataUrl),
            source: dataUrl ? "data-url" : null,
            // A machine that refused to stream and then sent nothing is the cause.
            failure: !dataUrl && streamRefused && scope.isRemote ? "unsent" : s.failure,
            loading: false,
            loaded: true,
          }));
        })
        .catch(() => {
          if (cancelled) return;
          setState((s) => ({
            preview: null,
            source: null,
            failure: scope.isRemote ? "unsent" : s.failure,
            loading: false,
            loaded: true,
          }));
        });
    };
    // Images on a paired machine stay on the data URL read; a video has no size cap this way.
    const mediaServer = video
      && !isWebClientMode()
      && !streamRefused
      && (allowLocalArtifactProtocol || Boolean(targetId && projectId));
    if (!mediaServer) {
      readDataUrl();
      return () => {
        cancelled = true;
      };
    }
    void window.ade.computerUse.mediaBaseUrl()
      .catch(() => null)
      .then((base) => {
        if (cancelled) return;
        let url: string | null = null;
        if (base && allowLocalArtifactProtocol) {
          url = localArtifactMediaUrl(base, artifact.uri, scope.rootPath);
        } else if (base) {
          url = remoteArtifactMediaUrl(base, {
            uri: artifact.uri,
            targetId: targetId ?? "",
            projectId: projectId ?? "",
            remoteProjectRoot: remoteRoot,
          });
        }
        if (!url) {
          readDataUrl();
          return;
        }
        setState((s) => ({
          ...s,
          preview: url,
          source: allowLocalArtifactProtocol ? "local-stream" : "remote-stream",
          loaded: true,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [
    allowLocalArtifactProtocol,
    artifact,
    loaded,
    projectId,
    remoteOffline,
    remoteRoot,
    streamRefused,
    scope.isRemote,
    scope.pin,
    scope.rootPath,
    targetId,
    visible,
  ]);

  const onMediaError = useCallback(() => {
    if (source === "remote-stream" || source === "local-stream") {
      // A paired machine on an older ADE has no range read, and an older main
      // may refuse a stream it cannot place. Try the capped data URL once,
      // which the host reads for this chat's project, before calling the
      // preview broken.
      setStreamRefused(true);
      setState((s) => ({ ...s, preview: null, source: null, loaded: false }));
      return;
    }
    setState((s) => ({ ...s, failure: "unplayable" }));
  }, [source]);

  // "unplayable" is only set on a loaded preview and cleared with it (a new
  // artifact resets the state).
  const failed = failure === "unplayable" || (loaded && !preview);
  const explanation = useMemo(() => artifactPreviewExplanation(artifact, {
    // Offline explains any failure on a paired machine, whatever broke first.
    reason: failed && !allowLocalArtifactProtocol && remoteOffline ? "offline" : failure,
    machineName: scope.machineName,
  }), [allowLocalArtifactProtocol, artifact, failed, failure, remoteOffline, scope.machineName]);

  return { containerRef, preview, loading, failed, explanation, onMediaError };
}
