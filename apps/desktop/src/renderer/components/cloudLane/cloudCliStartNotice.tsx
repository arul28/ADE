import { Terminal } from "@phosphor-icons/react";
import type { CloudAccountState } from "../../../shared/adeCloud";
import {
  CLOUD_ADS_WORDS,
  cloudAdsViewOf,
  cloudCliFullPriceSentence,
  cloudFullPriceNoticeShows,
} from "../../../shared/cloudAdPriceWords";
import { Dialog, openDialog } from "../ui/dialog";

/** What the person picked: open it as a chat, start the CLI anyway, or neither (closed). */
export type CloudCliStartChoice = "chat" | "cli" | null;

let asking: Promise<CloudCliStartChoice> | null = null;

/**
 * Pricing v3's notice when a person starts an agent CLI on a cloud computer
 * while ads are on: a CLI session uses the full price, a chat costs less.
 * "Open as a chat" (the default) or "Start CLI"; closing it starts nothing.
 * Every time, never remembered. Answers "cli" at once when there is nothing
 * to lose (no Pricing v3, ads off or not here, a discount of 0 on a paid plan).
 * Only for a start the person makes; a launch an agent or an automation makes
 * never asks.
 */
export function askCloudCliStart(account: CloudAccountState | null): Promise<CloudCliStartChoice> {
  const view = cloudAdsViewOf(account);
  if (!cloudFullPriceNoticeShows(view)) return Promise.resolve("cli");
  if (asking) return asking;
  asking = new Promise<CloudCliStartChoice>((resolve) => {
    let answered = false;
    const done = (choice: CloudCliStartChoice, close: () => void) => {
      if (answered) return;
      answered = true;
      asking = null;
      resolve(choice);
      close();
    };
    openDialog((close) => (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) done(null, close);
        }}
        title={cloudCliFullPriceSentence(view)}
        description={CLOUD_ADS_WORDS.whereShown}
        icon={<Terminal size={18} weight="duotone" />}
        size="sm"
        actions={[
          { label: CLOUD_ADS_WORDS.openAsChat, variant: "solid", autoFocus: true, onClick: () => done("chat", close) },
          { label: CLOUD_ADS_WORDS.startCli, variant: "secondary", onClick: () => done("cli", close) },
        ]}
      />
    ), { key: "cloud-cli-start" });
  });
  return asking;
}
