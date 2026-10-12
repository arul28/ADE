import { useEffect, useState } from "react";
import { PuzzlePiece } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { APP_BANNER_PRIORITY, useAppBanner } from "../ui/notice";
import { settingsRouteFor } from "../settings/settingsManifest";
import { dismissClaudeModsOffer, isClaudeModsOfferDismissed } from "./claudeModUiPrefs";

/**
 * Whether a chat has a mod installed. The plugin list is the chat's own (its
 * lane can add plugins) and reading it reads the disk, so each chat is asked
 * once per window: a mod installed later is noticed after a restart.
 */
const hasModsBySession = new Map<string, Promise<boolean>>();

function findInstalledMods(sessionId: string): Promise<boolean> {
  let found = hasModsBySession.get(sessionId);
  if (!found) {
    found = window.ade.agentChat.listClaudePlugins({ sessionId })
      .then((plugins) => plugins.some((plugin) => plugin.isMod === true))
      .catch(() => {
        // An older host cannot say. Ask again when the chat opens next.
        hasModsBySession.delete(sessionId);
        return false;
      });
    hasModsBySession.set(sessionId, found);
  }
  return found;
}

/**
 * Offers the mod UI setting, once, to a person who has Claude Code mods
 * installed and has the setting off. Runs for an open Claude chat on this
 * window's own machine (not the hosted client, not a subagent view, not a
 * chat on another machine: the setting and the plugins read here would be
 * this machine's).
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
