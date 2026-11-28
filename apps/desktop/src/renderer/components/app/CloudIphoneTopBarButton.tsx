import { useCallback, useRef, useState } from "react";
import { DeviceMobile } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { isAdeCloudBinding } from "../../../shared/adeCloud/binding";
import { CLOUD_PHONE_IDLE_MINUTES, CLOUD_PHONE_MODELS, CLOUD_PHONE_MAX_MINUTES, cloudPhoneDeviceOf } from "../../../shared/cloudPhone";
import { ipcErrorMessage } from "../../lib/format";
import { navigateToAppTarget } from "../../lib/openExternal";
import { fixedFrameOf, fixedRect, fixedViewport } from "../../lib/webZoom";
import {
  cloudPhoneIsUp,
  cloudPhoneMinutesLeft,
  formatPhoneSpan,
  CLOUD_PHONE_ALREADY_STOPPED as ALREADY_STOPPED,
  keepCloudPhoneOn,
  readCloudPhoneStatus,
  useCloudPhoneBackgroundReads,
  useCloudPhoneIdleCountdown,
  useCloudPhoneLive,
} from "../../state/cloudPhoneLive";
import { useCloudAccount } from "../../state/cloudAccountStore";
import { useTabCopyPin } from "../../state/repositoryScope";
import { cloudUnitWords } from "../../../shared/cloudUnitWords";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { InlineErrorNotice } from "../ui/notice/InlineErrorNotice";
import { HeaderSheet } from "./HeaderSheet";
import { BRAND } from "../../../shared/brand";

/**
 * The ADE Cloud iPhone in the top bar, only while one runs or starts: a phone
 * icon (a dot for its state) that opens what the phone is doing: its model,
 * how long it has been on, the credits left, when it stops with nothing
 * to do, and Keep on / Stop. One phone per account, so it is the same phone
 * whichever chat or machine started it.
 *
 * The phone is read through the tab's machine: it is the account's, so any
 * brain answers the same. Reads are `useCloudPhoneBackgroundReads`'s, shared
 * with the tools pane. A tab bound to ADE Cloud has no brain of its own to
 * ask (ADE Cloud as a machine refuses calls): there the icon follows only
 * what a tools pane reads.
 */
export function CloudIphoneTopBarButton({ enabled }: { enabled: boolean }) {
  const pin = useTabCopyPin();
  const reads = enabled && typeof window !== "undefined" && typeof window.ade?.cloudPhone?.status === "function";
  useCloudPhoneBackgroundReads(pin, reads && !isAdeCloudBinding(pin));
  const live = useCloudPhoneLive();
  const up = cloudPhoneIsUp(live);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const open = pos != null;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Minutes on the button need a slow tick; the open sheet's countdown a fast one near its end.
  const { now, stopAt, warn } = useCloudPhoneIdleCountdown(live, up, open);
  const close = useCallback(() => setPos(null), []);
  const toggle = () => {
    const el = buttonRef.current;
    if (open || !el) return close();
    // Hangs under the button, in the viewport frame the sheet is written in.
    const frame = fixedFrameOf(null);
    const rect = fixedRect(frame, el.getBoundingClientRect());
    setPos({ top: rect.bottom + 6, right: Math.max(8, fixedViewport(frame).width - rect.right) });
  };
  if (!reads || !up) return null;
  const starting = live.status?.phone?.state === "starting";
  const left = cloudPhoneMinutesLeft(live, now);
  const title = starting
    ? `${BRAND.CLOUD_NAME} iPhone starting`
    : `${BRAND.CLOUD_NAME} iPhone on${left != null ? ` · ${left} min left` : ""}${warn ? " · stopping soon with no input" : ""}`;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`${BRAND.CLOUD_NAME} iPhone`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        data-cloud-iphone-button=""
        data-state={starting ? "starting" : warn ? "warn" : "on"}
        className={cn(
          "ade-shell-control relative inline-flex h-[20px] w-[20px] shrink-0 items-center justify-center transition-[background-color,color,border-color,box-shadow] duration-150",
          open && "text-accent",
        )}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        onClick={toggle}
      >
        <DeviceMobile size={13} weight="regular" />
        <span
          aria-hidden
          className={cn(
            "absolute -right-0.5 -top-0.5 h-[7px] w-[7px] rounded-full border border-black/30",
            starting ? "animate-pulse bg-warning" : warn ? "bg-warning" : "bg-success",
          )}
        />
      </button>
      <HeaderSheet
        open={open}
        panelRef={panelRef}
        icon={<DeviceMobile size={15} weight="regular" className="shrink-0 text-fg/80" />}
        title={`${BRAND.CLOUD_NAME} iPhone`}
        ariaLabelledBy="cloud-iphone-sheet-title"
        width="w-[300px]"
        panelStyle={pos ? { top: pos.top, right: pos.right, left: "auto" } : undefined}
        onClose={close}
      >
        <CloudIphoneDetails now={now} warn={warn} stopAt={stopAt} pin={pin} onDone={close} />
      </HeaderSheet>
    </>
  );
}

function CloudIphoneDetails({
  now,
  warn,
  stopAt,
  pin,
  onDone,
}: {
  now: number;
  warn: boolean;
  stopAt: number | null;
  pin: OpenProjectBinding | null;
  onDone: () => void;
}) {
  const live = useCloudPhoneLive();
  const phone = live.status?.phone ?? null;
  const minutes = live.status?.minutes ?? null;
  // The iPhone draws from the account's credits (account level, no pin).
  const words = cloudUnitWords(useCloudAccount());
  const [busy, setBusy] = useState<"stop" | "keep" | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!phone) return null;
  const model = CLOUD_PHONE_MODELS[cloudPhoneDeviceOf(phone.device)];
  const starting = phone.state === "starting";
  const left = cloudPhoneMinutesLeft(live, now);
  const stopping = stopAt != null && stopAt - now <= 0;

  const act = (what: "stop" | "keep") => {
    if (busy) return;
    setBusy(what);
    setError(null);
    const call = what === "stop"
      ? window.ade.cloudPhone.stop(pin).then(() => readCloudPhoneStatus(pin)).then(() => { onDone(); return null; })
      : keepCloudPhoneOn(pin);
    void call
      .then(setError, (caught: unknown) => setError(caught instanceof Error ? ipcErrorMessage(caught) : String(caught)))
      .finally(() => setBusy(null));
  };

  const rows: Array<{ label: string; value: string; warn?: boolean }> = [
    { label: "Device", value: `${model.label} · iOS 27` },
    { label: "State", value: starting ? (phone.queueUntil ? "Waiting for a free phone" : "Starting") : "On" },
  ];
  if (!starting && phone.readyAt) rows.push({ label: "On for", value: `${formatPhoneSpan(now - phone.readyAt, false)} of ${CLOUD_PHONE_MAX_MINUTES / 60} h at most` });
  if (left != null && minutes) rows.push({ label: "Credits left", value: `${words.milli(left * words.phoneMilliPerMinute)}, about ${left} min` });
  if (!starting && stopAt != null) {
    rows.push({ label: "Idle stop", value: stopping ? "due now" : `in ${formatPhoneSpan(stopAt - now, warn)} with no input`, warn });
  }

  return (
    <div className="flex flex-col gap-2.5 p-4 pt-3" data-testid="cloud-iphone-details">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-sans text-[11.5px]">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted-fg">{row.label}</dt>
            <dd className={cn("min-w-0 text-fg/90 tabular-nums", row.warn && "text-warning")}>{row.value}</dd>
          </div>
        ))}
      </dl>
      {phone.stopNotice ? <p className="font-sans text-[11px] text-warning">{phone.stopNotice}</p> : null}
      <p className="font-sans text-[11px] leading-snug text-muted-fg">
        One phone for the account: every chat that uses ios@cloud drives this one. It stops after {CLOUD_PHONE_IDLE_MINUTES} minutes with no command or input.
      </p>
      {error ? (
        <InlineErrorNotice
          id="cloud_iphone.top_bar"
          message={error}
          report={error === ALREADY_STOPPED ? false : undefined}
          onDismiss={() => setError(null)}
        />
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          casing="sentence"
          onClick={() => {
            onDone();
            navigateToAppTarget({ kind: "settings", tab: "ade-cloud" });
          }}
        >
          Credits
        </Button>
        {!starting ? (
          <Button variant="outline" size="sm" casing="sentence" disabled={busy != null} onClick={() => act("keep")}>
            {busy === "keep" ? "Keeping on…" : "Keep on"}
          </Button>
        ) : null}
        <Button variant="danger" size="sm" casing="sentence" disabled={busy != null} onClick={() => act("stop")}>
          {busy === "stop" ? "Stopping…" : "Stop"}
        </Button>
      </div>
    </div>
  );
}
