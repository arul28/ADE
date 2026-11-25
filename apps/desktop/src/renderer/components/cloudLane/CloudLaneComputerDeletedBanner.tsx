import { useMemo, useState, type CSSProperties } from "react";
import { cloudCatalogOf, cloudHoursLeftMilli, type CloudAccountState } from "../../../shared/adeCloud";
import type { CloudLaneWithoutComputer } from "../../../shared/cloudLaneLife";
import { cloudTiers, type CloudTierId } from "../../../shared/cloudTiers";
import { pickCloudDefaultTier } from "../../lib/cloudDefaultTier";
import { pickNewComputerSize, useNewComputerSize } from "../../state/adeCloudChatQueue";
import { useRootAppStore } from "../../state/appStore";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { adeCloudDoBlock, useAdeCloudAccess } from "../../state/cloudAccess";
import { useCloudAccount } from "../../state/cloudAccountStore";
import { SAVED_CHAT_COMPUTER_GONE_MESSAGE, type SavedChatLocation } from "../../state/cloudSavedChats";
import { CloudSizeButton, TRAY_ACTION_LABEL } from "../chat/AdeCloudComposerParts";
import { adeCloudAccountBlock, type AdeCloudTrayAction } from "../chat/useAdeCloudDraft";
import { CloudMark } from "../remoteTargets/cloudBrand";
import { Banner, NoticePopover, type NoticeAction } from "../ui/notice";
import { cloudLaneRestartProblem, cloudLaneRestartTier, useStartLaneOnNewComputer } from "./CloudLaneWithoutComputer";
import { cloudUnitWords } from "../../../shared/cloudUnitWords";
import {
  CLOUD_QUEUE_SIZE_ID,
  canDeleteCloudLaneWithoutComputer,
  cloudLaneWithoutComputerBranch,
  cloudLaneWithoutComputerDeleteLabel,
  cloudLaneWithoutComputerFate,
  cloudLaneWithoutComputerRowNow,
  cloudQueueSizeLabel,
  cloudTierLabel,
  deleteCloudLaneWithoutComputer,
  savedChatFateSentence,
  type CloudLaneWithoutComputerRow,
} from "./cloudLanesWithoutComputer";

/**
 * A lane whose ADE Cloud computer was deleted looks like a sleeping one: the
 * lane and its chats stay as they were, and one inline banner says the
 * computer was deleted and what the next message does. Shown in the chat's
 * banner stack (a kept lane's chat and a plain deleted computer's saved chat
 * alike) and in the Lanes tab's detail of such a lane.
 *
 * A send in the chat goes through the account's queue
 * (`sendThroughCloudQueue`): the server makes a new computer for the lane at
 * the size picked in the banner's chip, else at ADE's size, Small or bigger
 * (`cloudQueueSizeLabel`), and continues the chat there. A server without the queue gets a kept lane's
 * old path, a new chat on a new computer at the old size
 * (`startFreedLaneChat`). When a new computer can't start, the banner turns
 * to a warning with the reason, and the composer's Send is off with the same
 * reason (`blocked.message` in its send-blocked chain).
 *
 * Everything it does is account level: the kept lane, the saved chats, the
 * account's hours and disk. Nothing goes through a pin.
 */

export type CloudLaneComputerDeleted = {
  laneId: string;
  laneName: string;
  /** What happened to the computer, in the shared words (`cloudComputerFateSentence`). */
  fate: string;
  /** The branch a new computer starts on, or null when ADE never learned it. */
  branch: string | null;
  /** The size a new computer starts at, as the catalog names it. */
  sizeLabel: string;
  /** Why no new computer can start now, and the fixes that reason implies. */
  blocked: { message: string; actions: AdeCloudTrayAction[] } | null;
  kept: CloudLaneWithoutComputer | null;
};

/**
 * The banner's facts for a chat (or a lane) whose computer is gone. `viaQueue`:
 * the next step is the account's queue (a send in the chat); false is a kept
 * lane's own new computer at its old size. Pure.
 */
export function cloudLaneComputerDeletedFacts(input: {
  laneId: string;
  laneName: string;
  kept: CloudLaneWithoutComputer | null;
  /** The saved chats' answer for their computer, when the lane wasn't kept. */
  computer: SavedChatLocation["row"]["computer"] | null;
  /** The lane's branch as its saved chats list it, when not kept. */
  branch?: string | null;
  account: CloudAccountState | null;
  /** Why ADE Cloud can't start or wake anything now (`adeCloudDoBlock`: blocked, signed out), or null. */
  doBlock: string | null;
  defaultTier: CloudTierId;
  viaQueue: boolean;
  binding: OpenProjectBinding | null;
  originUrl: string | null;
}): CloudLaneComputerDeleted {
  const { kept, account } = input;
  const fate = kept ? cloudLaneWithoutComputerFate({ kept, computer: null }) : savedChatFateSentence(input.computer);
  const branch = cloudLaneWithoutComputerBranch(kept, input.branch ?? null);
  const accountBlock = adeCloudAccountBlock(account, { newLane: true });
  // Without the queue, the new computer starts from this window: a kept lane's own start, or nothing.
  const localProblem = input.viaQueue
    ? null
    : kept ? cloudLaneRestartProblem(kept, input.binding, input.originUrl) : SAVED_CHAT_COMPUTER_GONE_MESSAGE;
  const blocked = input.doBlock
    ? { message: input.doBlock, actions: [] }
    : accountBlock
      ? { message: accountBlock.message, actions: accountBlock.actions }
      : localProblem ? { message: localProblem, actions: [] } : null;
  return {
    laneId: input.laneId,
    laneName: kept?.laneName ?? input.laneName,
    fate,
    branch,
    sizeLabel: input.viaQueue || !kept ? cloudQueueSizeLabel(account) : cloudTierLabel(account, cloudLaneRestartTier(kept, account, input.defaultTier)),
    blocked,
    kept,
  };
}

/** "Why?": why ADE Cloud deletes a computer, and what stays. ADE's own words, so they show in replays. */
function WhyComputerDeleted({ onOpenPlans }: { onOpenPlans?: (() => void) | null }) {
  const [open, setOpen] = useState(false);
  return (
    <NoticePopover
      open={open}
      onOpenChange={setOpen}
      width={300}
      unmask
      trigger={(
        <button
          type="button"
          className="ml-1 rounded px-0.5 font-medium text-fg/75 underline decoration-fg/25 underline-offset-2 hover:bg-fg/[0.06] hover:text-fg"
          aria-label="Why ADE Cloud deleted this computer"
        >
          Why?
        </button>
      )}
    >
      <p className="m-0 text-[12px] leading-snug text-fg/85">
        ADE Cloud deletes a computer that isn&apos;t used for a while, or to fit your plan, so it doesn&apos;t use your credits and disk.
      </p>
      <p className="m-0 text-[12px] leading-snug text-fg/85">
        Your chats and the work that isn&apos;t on GitHub stay on your account. A new computer gets them back.
      </p>
      {onOpenPlans ? (
        <button
          type="button"
          className="self-start rounded px-0.5 text-[12px] font-medium text-fg/75 underline decoration-fg/25 underline-offset-2 hover:bg-fg/[0.06] hover:text-fg"
          onClick={() => {
            setOpen(false);
            onOpenPlans();
          }}
        >
          See plans
        </button>
      ) : null}
    </NoticePopover>
  );
}

/** Delete for the banner: the same flow the old lanes-without-a-computer list ran, with its confirm. */
function useDeleteAction(facts: CloudLaneComputerDeleted, row: CloudLaneWithoutComputerRow | null): NoticeAction | null {
  const [busy, setBusy] = useState(false);
  // The row as the stores hold it at the click: its chats and slices now.
  const target = () => row ?? cloudLaneWithoutComputerRowNow(facts.laneId, facts.kept, facts.laneName);
  const preview = row ?? { kept: facts.kept, sessions: [] };
  if (!canDeleteCloudLaneWithoutComputer(preview)) return null;
  return {
    label: row ? cloudLaneWithoutComputerDeleteLabel(row) : facts.kept ? "Delete lane" : "Delete chats",
    variant: "secondary",
    busy,
    onClick: () => {
      if (busy) return;
      setBusy(true);
      void deleteCloudLaneWithoutComputer(target()).finally(() => setBusy(false));
    },
  };
}

/**
 * The size chip of the new computer a chat's next message makes: ADE's size
 * (Small, or bigger if the project needed it) until the person picks one.
 */
function NewComputerSizeChip({ machineKey, account, picked }: { machineKey: string; account: CloudAccountState | null; picked: CloudTierId | null }) {
  const defaultTier = useRootAppStore((state) => state.cloudDefaultTier);
  const tiers = useMemo(() => cloudTiers(cloudCatalogOf(account)), [account]);
  return (
    <CloudSizeButton
      tiers={tiers}
      tierId={picked ?? CLOUD_QUEUE_SIZE_ID}
      defaultTier={defaultTier}
      onChoose={(tier) => pickNewComputerSize(machineKey, tier)}
      onSetDefault={pickCloudDefaultTier}
      hoursLeftMilli={account ? cloudHoursLeftMilli(account) : null}
      words={cloudUnitWords(account)}
    />
  );
}

export function CloudLaneComputerDeletedBanner({
  facts,
  where = "chat",
  row = null,
  onOpenSettings,
  onOpenChat,
  newComputer = null,
  sizeMachineKey = null,
  style,
}: {
  facts: CloudLaneComputerDeleted;
  /** `chat`: in the chat's banner stack. `lane`: the Lanes tab's detail of the lane. */
  where?: "chat" | "lane";
  /** The lane's row, when the surface holds one (Lanes); a chat reads it at the click. */
  row?: CloudLaneWithoutComputerRow | null;
  /** Settings › ADE Cloud, opened where a fix is (the composer's `openSettings`). */
  onOpenSettings?: ((action: AdeCloudTrayAction) => void) | null;
  /** Lanes: open the lane's newest chat. */
  onOpenChat?: (() => void) | null;
  /** Lanes, a kept lane with no chat: its own "New computer". */
  newComputer?: { start: () => void; busy: boolean } | null;
  /** A chat whose next message goes through the account's queue: the deleted computer's key, for the new computer's size chip. */
  sizeMachineKey?: string | null;
  style?: CSSProperties;
}) {
  const deleteAction = useDeleteAction(facts, row);
  const picked = useNewComputerSize(sizeMachineKey);
  const account = useCloudAccount(Boolean(sizeMachineKey));
  const branch = facts.branch ?? "the lane's branch";
  const sizeLabel = picked ? cloudTierLabel(account, picked) : facts.sizeLabel;
  if (facts.blocked) {
    const fixes: NoticeAction[] = onOpenSettings
      ? facts.blocked.actions.map((action) => ({ label: TRAY_ACTION_LABEL[action], onClick: () => onOpenSettings(action) }))
      : [];
    return (
      <Banner
        layout="inline"
        style={style}
        testId="cloud-lane-computer-deleted"
        model={{
          id: "cloud-lane-computer-deleted-blocked",
          tone: "warning",
          icon: <CloudMark size={13} brand />,
          title: "ADE can't make a new computer for this lane",
          detail: facts.blocked.message,
          actions: [...fixes, ...(onOpenChat ? [{ label: "Open chat", variant: "secondary" as const, onClick: onOpenChat }] : []), ...(deleteAction ? [deleteAction] : [])],
        }}
      />
    );
  }
  const next = where === "chat"
    ? `Your next message makes a new computer on ${branch}, at ${sizeLabel}, and continues this chat there.`
    : newComputer
      ? `A new computer for it starts on ${branch}, at ${facts.sizeLabel}.`
      : `A message in its chat makes a new computer on ${branch}, at ${facts.sizeLabel}, and continues the chat there.`;
  const primary: NoticeAction[] = newComputer
    ? [{ label: newComputer.busy ? "Starting…" : "New computer", busy: newComputer.busy, onClick: newComputer.start }]
    : onOpenChat ? [{ label: "Open chat", onClick: onOpenChat }] : [];
  return (
    <Banner
      layout="inline"
      style={style}
      testId="cloud-lane-computer-deleted"
      model={{
        id: "cloud-lane-computer-deleted",
        tone: "info",
        icon: <CloudMark size={13} brand />,
        title: "This lane's ADE Cloud computer was deleted",
        detail: (
          <>
            {facts.fate} {next}
            <WhyComputerDeleted onOpenPlans={onOpenSettings ? () => onOpenSettings("upgrade") : null} />
          </>
        ),
        actions: [...primary, ...(deleteAction ? [deleteAction] : [])],
        extra: sizeMachineKey ? <NewComputerSizeChip machineKey={sizeMachineKey} account={account} picked={picked} /> : undefined,
      }}
    />
  );
}

/**
 * The Lanes tab's detail of a lane whose computer was deleted: its name and
 * the banner. Opening a row with chats goes to its newest chat (Work); this
 * shows when the lane is opened another way (the first lane, the keys) or
 * has no chat yet.
 */
export function CloudLaneWithoutComputerDetail({
  row,
  binding,
  originUrl,
  defaultTier,
  onOpenChat,
  onOpenSettings,
}: {
  row: CloudLaneWithoutComputerRow;
  binding: OpenProjectBinding | null;
  originUrl: string | null;
  defaultTier: CloudTierId;
  onOpenChat: ((sessionId: string) => void) | null;
  onOpenSettings: (action: AdeCloudTrayAction) => void;
}) {
  const account = useCloudAccount();
  const doBlock = adeCloudDoBlock(useAdeCloudAccess());
  const newest = row.sessions[0] ?? null;
  // A lane with no chat starts its own new computer; one with chats goes on in its chat.
  const startsOwn = !newest && row.kept != null;
  const start = useStartLaneOnNewComputer(startsOwn ? row.kept : null, account);
  const facts = cloudLaneComputerDeletedFacts({
    laneId: row.laneId,
    laneName: row.laneName,
    kept: row.kept,
    computer: row.computer,
    branch: row.lane?.branchRef ?? null,
    account,
    doBlock,
    defaultTier,
    viaQueue: !startsOwn && Boolean(window.ade?.cloud?.sendChatMessage),
    binding,
    originUrl,
  });
  const shown = startsOwn && start.problem && !facts.blocked ? { ...facts, blocked: { message: start.problem, actions: [] } } : facts;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="lane-detail-cloud-computer-deleted">
      <div className="shrink-0 px-4 pt-3">
        <div className="truncate text-[13px] font-medium text-fg">{row.laneName}</div>
      </div>
      <CloudLaneComputerDeletedBanner
        facts={shown}
        where="lane"
        row={row}
        onOpenSettings={onOpenSettings}
        onOpenChat={newest && onOpenChat ? () => onOpenChat(newest.id) : null}
        newComputer={startsOwn ? { start: () => void start.start(), busy: start.busy } : null}
        style={{ margin: "8px 16px", flexShrink: 0 }}
      />
    </div>
  );
}
