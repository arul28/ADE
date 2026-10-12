import { useEffect, useState } from "react";
import { PuzzlePiece } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { APP_BANNER_PRIORITY, useAppBanner } from "../ui/notice";
import { settingsRouteFor } from "../settings/settingsManifest";
import { dismissClaudeModsOffer, isClaudeModsOfferDismissed } from "./claudeModUiPrefs";

/**
 * Whether this person has a mod installed. Listing plugins reads the disk, so
 * the answer is kept for the window: a mod installed later is noticed after a
 * restart.
 */
let hasModsInstalled: Promise<boolean> | null = null;

function findInstalledMods(sessionId: string): Promise<boolean> {
  hasModsInstalled ??= window.ade.agentChat.listClaudePlugins({ sessionId })
    .then((plugins) => plugins.some((plugin) => plugin.isMod === true))
    .catch(() => {
      // An older host cannot say. Ask again on the next chat.
      hasModsInstalled = null;
      return false;
    });
  return hasModsInstalled;
}

/**
 * Offers the mod UI setting, once, to a person who has Claude Code mods
 * installed and has the setting off. Runs for an open Claude chat in the
 * desktop window only (not the hosted client, not a subagent view).
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
      // The plugin list is read only while there is an offer to make.
      const hasMods = await findInstalledMods(sessionId);
      if (!cancelled) setOffer(hasMods);
    })().catch(() => {
      // The configuration did not load; no offer.
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
