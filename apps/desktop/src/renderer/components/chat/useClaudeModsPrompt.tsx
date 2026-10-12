import { useEffect, useState } from "react";
import { PuzzlePiece } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { AiConfig } from "../../../shared/types";
import { APP_BANNER_PRIORITY, useAppBanner } from "../ui/notice";
import { settingsRouteFor } from "../settings/settingsManifest";

/** Set once the person closes the prompt; it is an offer, so it does not come back. */
const DISMISSED_KEY = "ade.chat.claudeModUi.promptDismissed";

function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Offers the mod UI setting, once, to a person who has Claude Code mods
 * installed and has the setting off. Runs for an open Claude chat only.
 */
export function useClaudeModsPrompt(sessionId: string | null): void {
  const navigate = useNavigate();
  const [offer, setOffer] = useState(false);

  useEffect(() => {
    setOffer(false);
    if (!sessionId || wasDismissed()) return;
    let cancelled = false;
    void Promise.all([
      window.ade.projectConfig.get(),
      window.ade.agentChat.listClaudePlugins({ sessionId }),
    ])
      .then(([config, plugins]) => {
        if (cancelled) return;
        const ai = config.effective?.ai as AiConfig | undefined;
        const enabled = ai?.chat?.claudePluginUiEnabled === true;
        setOffer(!enabled && plugins.some((plugin) => plugin.isMod === true));
      })
      .catch(() => {
        // An older host cannot say; no offer.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Storage is unavailable: the offer is gone for this window.
    }
    setOffer(false);
  };

  useAppBanner(
    offer && {
      id: "claude-mods-offer",
      tone: "info",
      icon: <PuzzlePiece />,
      title: "ADE can show your Claude mods in chats",
      actions: [{
        label: "Turn on in Settings",
        onClick: () => {
          dismiss();
          navigate(settingsRouteFor("chat.claude-mods"));
        },
      }],
      dismiss: { onDismiss: dismiss },
    },
    { placement: "floating", priority: APP_BANNER_PRIORITY.prompt },
  );
}
