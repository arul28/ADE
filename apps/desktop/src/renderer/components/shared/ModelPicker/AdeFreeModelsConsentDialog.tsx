import { BRAND } from "../../../../shared/brand";
import { useState } from "react";
import { ChatsCircle, Eye, Gift, GlobeHemisphereWest, ShareNetwork } from "@phosphor-icons/react";
import type { CloudSponsoredConsent } from "../../../../shared/adeCloud";
import { setCloudFreeModelsConsent } from "../../../state/cloudAccountStore";
import { ipcErrorMessage } from "../../../lib/format";
import { showToast } from "../../app/toast/toastStore";
import { Dialog, openDialog } from "../../ui/dialog";

/**
 * The one-time sheet before a person's first ADE Free Models chat
 * (`shared/adeFreeModels.ts`): these models are free because their chats show
 * sponsored cards, and what Gravity, who hosts them, receives. The answer is
 * saved on the account server, so it holds on every machine, the web and the
 * phone. The two answers look the same: a yes is consent, so it is never the
 * louder button.
 */

const FACTS: ReadonlyArray<{ icon: typeof Eye; text: string; fine?: boolean }> = [
  { icon: Eye, text: "Each chat that uses them shows an ad after a finished reply, on any computer and any plan." },
  {
    icon: ShareNetwork,
    text: `To run them, ${BRAND.NAME} sends Gravity, the partner that hosts them, everything these chats send the model (your messages, the agent's replies, and the files and tool output it reads), your IP address and a hashed copy of your account email. Gravity keeps a license to use what is sent.`,
  },
  { icon: ChatsCircle, text: `They answer only while you have the chat open in ${BRAND.NAME}, so automations and the CLI can't use them.` },
  { icon: GlobeHemisphereWest, text: "Only in the US and Canada. Ads are for people 18 or older.", fine: true },
];

function AdeFreeModelsConsentDialog({ onDone }: { onDone: (granted: boolean) => void }) {
  const [busy, setBusy] = useState<CloudSponsoredConsent | null>(null);
  const answer = (consent: CloudSponsoredConsent) => {
    setBusy(consent);
    void setCloudFreeModelsConsent(consent).then(
      () => onDone(consent === "granted"),
      (error: unknown) => {
        setBusy(null);
        showToast({ tone: "error", title: "Couldn't save your answer", message: ipcErrorMessage(error) || "Try again in a moment." });
      },
    );
  };
  return (
    <Dialog
      open
      size="md"
      icon={<Gift size={16} weight="duotone" />}
      title={`Use ${BRAND.NAME} Free Models?`}
      description="These models are free because ads pay for them."
      dismissible={busy === null}
      onOpenChange={(open) => {
        if (!open && busy === null) onDone(false);
      }}
      actions={[
        { label: "Agree", variant: "secondary", busy: busy === "granted", disabled: busy !== null, onClick: () => answer("granted") },
        { label: "Not now", variant: "secondary", busy: busy === "declined", disabled: busy !== null, onClick: () => answer("declined") },
      ]}
      testId="ade-free-models-consent"
    >
      <ul className="flex flex-col gap-2.5 text-[12.5px] leading-snug text-fg/85">
        {FACTS.map(({ icon: Icon, text, fine }) => (
          <li key={text} className={fine ? "flex gap-2.5 text-[11.5px] text-muted-fg" : "flex gap-2.5"}>
            <Icon size={15} className="mt-px shrink-0 text-muted-fg" aria-hidden />
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

let asking: Promise<boolean> | null = null;

/**
 * Opens the sheet and resolves true once the account said yes. A no is saved
 * too (the person is asked again on their next pick); closing it saves
 * nothing. One sheet at a time: a second ask gets the open one's answer.
 */
export function askAdeFreeModelsConsent(): Promise<boolean> {
  if (asking) return asking;
  asking = new Promise<boolean>((resolve) => {
    openDialog((close) => (
      <AdeFreeModelsConsentDialog
        onDone={(granted) => {
          asking = null;
          resolve(granted);
          close();
        }}
      />
    ), { key: "ade-free-models-consent" });
  });
  return asking;
}
