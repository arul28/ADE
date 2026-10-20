import { useCallback, useEffect, useState } from "react";
import type { AiChatConfig } from "../../../shared/types";
import { captureError } from "../../../shared/sentry/capture";
import { isWebClientMode } from "../../lib/webClientMode";
import { showToast } from "../app/toast/toastStore";
import { useSettingsMachineScope } from "./SettingsMachineScope";

type BooleanChatKey = {
  [K in keyof AiChatConfig]-?: NonNullable<AiChatConfig[K]> extends boolean ? K : never;
}[keyof AiChatConfig];

/**
 * One boolean `ai.chat` setting from the project's `.ade/local.yaml`, on the
 * machine this settings page is scoped to. Off unless set to true. Saves
 * optimistically; a failed save puts it back and says so. The hosted client
 * cannot write the host's project configuration, so there it does nothing.
 */
export function useChatConfigToggle(key: BooleanChatKey) {
  const { pin } = useSettingsMachineScope();
  const pinKey = pin?.key ?? null;
  const onWeb = isWebClientMode();
  const [status, setStatus] = useState<"loading" | "loaded" | "failed">("loading");
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (onWeb) return;
    let cancelled = false;
    setStatus("loading");
    void window.ade.projectConfig.get(pin)
      .then((snapshot) => {
        if (cancelled) return;
        setEnabled(snapshot.effective.ai?.chat?.[key] === true);
        setStatus("loaded");
      })
      .catch((error) => {
        if (cancelled) return;
        captureError(error, {
          tags: { feature: "settings", action: "chat_config_load" },
          fingerprint: ["settings", "chat_config_load", key],
          handled: true,
        });
        setStatus("failed");
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the machine, not the pin object: a rebuilt pin is the same machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, onWeb, pinKey]);

  const save = useCallback(async (value: boolean) => {
    if (saving) return;
    setSaving(true);
    setEnabled(value);
    try {
      await window.ade.ai.updateConfig({ chat: { [key]: value } }, pin);
    } catch (error) {
      setEnabled(!value);
      showToast({
        title: "Couldn't save the setting",
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  }, [key, pin, saving]);

  return { onWeb, status, saving, enabled, save };
}
