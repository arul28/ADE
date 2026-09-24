import { useCallback, useRef, useState } from "react";
import type { NewLaneDraftConfig } from "../lanes/CreateLaneDialogHost";

/**
 * Composer state for a lane configured from the picker's "+" but not yet
 * created. The recipe is held here and rides the auto-create target until the
 * chat is sent; `pendingRendererRef` carries it one-shot to the renderer-owned
 * fallback when the connected host cannot run the brain-owned launch. Extracted
 * from `AgentChatPane` so that coordinator does not grow another responsibility.
 */
export function useNewLaneDraftConfig(args: {
  setError: (message: string | null) => void;
  setDraftLaunchTargetId: (targetId: string | null) => void;
  /** The synthetic picker id the recipe rides (the auto-create option). */
  autoCreateOptionId: string;
}) {
  const { setError, setDraftLaunchTargetId, autoCreateOptionId } = args;
  const [config, setConfig] = useState<NewLaneDraftConfig | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  /** Latest recipe, readable from detached launch callbacks without a stale closure. */
  const configRef = useRef<NewLaneDraftConfig | null>(null);
  const pendingRendererRef = useRef<NewLaneDraftConfig | null>(null);

  const applyConfigured = useCallback((next: NewLaneDraftConfig) => {
    configRef.current = next;
    setError(null);
    setConfig(next);
    // Ride the auto-create target: the lane is not created until send.
    setDraftLaunchTargetId(autoCreateOptionId);
  }, [autoCreateOptionId, setDraftLaunchTargetId, setError]);
  const clearConfig = useCallback(() => {
    configRef.current = null;
    setConfig(null);
  }, []);

  return {
    config,
    configRef,
    pendingRendererRef,
    dialogOpen,
    setDialogOpen,
    applyConfigured,
    clearConfig,
  };
}
