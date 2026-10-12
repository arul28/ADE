import { useEffect, useState } from "react";
import { PuzzlePiece } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { APP_BANNER_PRIORITY, useAppBanner } from "../ui/notice";
import { settingsRouteFor } from "../settings/settingsManifest";
import { dismissClaudeModsOffer, isClaudeModsOfferDismissed } from "./claudeModUiPrefs";

/**
 * Offers the mod UI setting, once, to a person who has Claude Code mods
 * installed and has the setting off. Runs for an open Claude chat only.
 */
export function useClaudeModsPrompt(sessionId: string | null): void {
  const navigate = useNavigate();
  const [offer, setOffer] = useState(false);

  useEffect(() => {
    setOffer(false);
    if (!sessionId || isClaudeModsOfferDismissed()) return;
    let cancelled = false;
    void (async () => {
      const config = await window.ade.projectConfig.get();
      if (cancelled || config.effective.ai?.chat?.claudePluginUiEnabled === true) return;
      // Listing plugins reads the disk, so it runs only while there is an offer to make.
      const plugins = await window.ade.agentChat.listClaudePlugins({ sessionId });
      if (!cancelled) setOffer(plugins.some((plugin) => plugin.isMod === true));
    })().catch(() => {
      // An older host cannot say; no offer.
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const dismiss = () => {
    dismissClaudeModsOffer();
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
