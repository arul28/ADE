import { useCallback, useEffect, useRef, useState } from "react";
import type { MuseSettingsRequest, MuseSettingsResult } from "../../../../../../shared/museSettings";
import type { OpenProjectBinding } from "../../../../../../shared/types";
import type { MuseRun } from "./museSettingsShared";

function newHandleId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `muse-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * One Settings host per page visit on the page's machine. The id is per mount:
 * switching machine remounts the page, which closes the old machine's host.
 */
export function useMuseSettingsHost(pin: OpenProjectBinding | null): { run: MuseRun } {
  const pinRef = useRef(pin);
  pinRef.current = pin;
  // The page remounts per machine (MuseBody keys it by pin), so one id per mount is one id per machine.
  const [handleId] = useState(newHandleId);
  useEffect(() => {
    const closingPin = pinRef.current;
    return () => {
      void window.ade?.ai?.museSettingsClose?.({ handleId }, closingPin).catch(() => undefined);
    };
  }, [handleId]);
  const run = useCallback(
    async <R extends MuseSettingsRequest>(request: R): Promise<MuseSettingsResult<R["kind"]>> => {
      const call = window.ade?.ai?.museSettings;
      if (!call) throw new Error("This ADE build cannot manage Muse settings on that machine. Update ADE there and try again.");
      return await call({ handleId, request }, pinRef.current);
    },
    [handleId],
  );
  return { run };
}
