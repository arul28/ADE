import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../ui/cn";
import {
  createH264StreamPlayer,
  type H264StreamSource,
  type H264StreamStatus,
} from "./h264StreamPlayer";

/**
 * The live H.264 picture: a canvas over `createH264StreamPlayer`. The Apple
 * device stage, the Mac Desktop pane and mini player, and the web client's
 * read-only Mac view all draw through this one component; the decoding rules
 * live in the player.
 */

export type H264StreamViewProps = {
  /**
   * Where the access units come from. Null draws nothing and reports
   * `stopped`. Compared by its fields (kind, url, token, subscribe), so an
   * inline literal does not redial on every render.
   */
  source: H264StreamSource | null;
  className?: string;
  /** Bumping this reconnects. Use it after a port forward is rebuilt. */
  reconnectNonce?: number;
  /** See `H264StreamPlayerOptions.streamName`. */
  streamName?: string;
  /** See `H264StreamPlayerOptions.streamGoneCode`. */
  streamGoneCode?: string;
  onStatus?: (status: H264StreamStatus, error: string | null) => void;
  onDimensions?: (size: { width: number; height: number }) => void;
  onCanvas?: (canvas: HTMLCanvasElement | null) => void;
  /** Fired once per frame actually drawn. See `H264StreamPlayerOptions.onFrame`. */
  onFrame?: () => void;
};

export function H264StreamView({
  source,
  className,
  reconnectNonce = 0,
  streamName,
  streamGoneCode,
  onStatus,
  onDimensions,
  onCanvas,
  onFrame,
}: H264StreamViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<H264StreamStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const dimensionsRef = useRef(onDimensions);
  dimensionsRef.current = onDimensions;
  const frameRef = useRef(onFrame);
  frameRef.current = onFrame;
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const setCanvasNode = useCallback((node: HTMLCanvasElement | null) => {
    canvasRef.current = node;
    onCanvas?.(node);
  }, [onCanvas]);

  // What identifies a stream. A token rotates on the same loopback port when
  // the stream restarts, so a reader keyed only on the url would keep
  // presenting a token the helper has already invalidated.
  const kind = source?.kind ?? null;
  const url = source && source.kind !== "push" ? source.url : null;
  const bearerToken = source?.kind === "http" ? source.bearerToken ?? null : null;
  const subscribe = source?.kind === "push" ? source.subscribe : null;

  useEffect(() => {
    const report = (next: H264StreamStatus, nextError: string | null): void => {
      setStatus(next);
      setError(nextError);
      statusRef.current?.(next, nextError);
    };
    const current = sourceRef.current;
    if (!current) {
      report("stopped", null);
      return undefined;
    }
    const player = createH264StreamPlayer({
      source: current,
      canvas: canvasRef.current,
      streamName,
      streamGoneCode,
      onStatus: report,
      onDimensions: (size) => dimensionsRef.current?.(size),
      onFrame: () => frameRef.current?.(),
    });
    return () => player.stop();
  }, [kind, url, bearerToken, subscribe, reconnectNonce, streamName, streamGoneCode]);

  return (
    <canvas
      ref={setCanvasNode}
      className={cn("h-full w-full object-contain", className)}
      data-testid="ios-h264-canvas"
      data-status={status}
      data-error={error ?? undefined}
    />
  );
}
