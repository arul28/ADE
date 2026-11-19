import { useRef, useState } from "react";
import { DeviceMobile } from "@phosphor-icons/react";
import { CLOUD_PHONE_MODELS, CLOUD_PHONE_MAX_MINUTES, cloudPhoneDeviceOf } from "../../../shared/cloudPhone";
import { ipcErrorMessage } from "../../lib/format";
import { navigateToAppTarget } from "../../lib/openExternal";
import {
  cloudPhoneIdleStopAt,
  cloudPhoneIsUp,
  cloudPhoneMinutesLeft,
  formatPhoneSpan,
  publishCloudPhoneStatus,
  useCloudPhoneBackgroundReads,
  useCloudPhoneLive,
  usePhoneClock,
} from "../../state/cloudPhoneLive";
import { useTabCopyPin } from "../../state/repositoryScope";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { MENU_SURFACE_CLASS } from "../ui/paneMenuTokens";

/** The idle countdown counts in seconds, and Keep on shows, in its last stretch. */
const IDLE_WARN_MS = 90_000;

/**
 * The ADE Cloud iPhone in the top bar, only while one runs or starts: a phone
 * icon (a dot for its state) that opens what the phone is doing: its model,
 * how long it has been on, the plan's minutes left, when it stops with nothing
 * to do, and Keep on / Stop. One phone per account, so it is the same phone
 * whichever chat or machine started it.
 *
 * The phone is read through the tab's machine: it is the account's, so any
 * brain answers the same. Reads are `useCloudPhoneBackgroundReads`'s, shared
 * with the tools pane.
 */
export function CloudIphoneTopBarButton({ enabled }: { enabled: boolean }) {
  const pin = useTabCopyPin();
  const reads = enabled && typeof window !== "undefined" && typeof window.ade?.cloudPhone?.status === "function";
  useCloudPhoneBackgroundReads(pin, reads);
  const live = useCloudPhoneLive();
  const up = cloudPhoneIsUp(live);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const stopAt = cloudPhoneIdleStopAt(live);
  const warnNow = stopAt != null && stopAt - Date.now() <= IDLE_WARN_MS;
  // Minutes on the button need a slow tick; the open popover's countdown a fast one near its end.
  const now = usePhoneClock(up, open && warnNow);
  const warn = stopAt != null && stopAt - now <= IDLE_WARN_MS;
  if (!reads || !up) return null;
  const starting = live.status?.phone?.state === "starting";
  const left = cloudPhoneMinutesLeft(live, now);
  const title = starting
    ? "ADE Cloud iPhone starting"
    : `ADE Cloud iPhone on${left != null ? ` · ${left} min left` : ""}${warn ? " · stopping soon with no input" : ""}`;
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label="ADE Cloud iPhone"
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
        onClick={() => setOpen((current) => !current)}
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
      <AnchoredMenu
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        offset={6}
        remeasureKey={`${starting}:${warn}`}
        role="dialog"
        aria-label="ADE Cloud iPhone"
        className={cn(MENU_SURFACE_CLASS, "w-[280px] p-3")}
      >
        <CloudIphoneDetails now={now} warn={warn} stopAt={stopAt} pin={pin} onDone={() => setOpen(false)} />
      </AnchoredMenu>
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
  pin: ReturnType<typeof useTabCopyPin>;
  onDone: () => void;
}) {
  const live = useCloudPhoneLive();
  const phone = live.status?.phone ?? null;
  const minutes = live.status?.minutes ?? null;
  const [busy, setBusy] = useState<"stop" | "keep" | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!phone) return null;
  const model = CLOUD_PHONE_MODELS[cloudPhoneDeviceOf(phone.device)];
  const starting = phone.state === "starting";
  const left = cloudPhoneMinutesLeft(live, now);
  const canKeep = typeof window.ade?.cloudPhone?.keepAlive === "function";

  const reread = async () => {
    const startedAt = Date.now();
    const next = await window.ade.cloudPhone.status(pin).catch(() => null);
    if (next) publishCloudPhoneStatus(next, startedAt);
  };
  const act = (what: "stop" | "keep") => {
    if (busy) return;
    setBusy(what);
    setError(null);
    const call = what === "stop" ? window.ade.cloudPhone.stop(pin) : window.ade.cloudPhone.keepAlive?.(pin);
    void Promise.resolve(call)
      .then(() => reread())
      .then(() => { if (what === "stop") onDone(); })
      .catch((caught: unknown) => setError(caught instanceof Error ? ipcErrorMessage(caught) : String(caught)))
      .finally(() => setBusy(null));
  };

  const rows: Array<[string, string]> = [
    ["Device", `${model.label} · iOS 27`],
    ["State", starting ? (phone.queueUntil ? "Waiting for a free phone" : "Starting") : "On"],
  ];
  if (!starting && phone.readyAt) rows.push(["On for", `${formatPhoneSpan(now - phone.readyAt, false)} of ${CLOUD_PHONE_MAX_MINUTES / 60} h at most`]);
  if (left != null && minutes) rows.push(["Plan minutes", `${left} of ${minutes.included} left`]);
  if (!starting && stopAt != null) {
    rows.push(["Idle stop", stopAt - now > 0 ? `in ${formatPhoneSpan(stopAt - now, warn)} with no input` : "now"]);
  }

  return (
    <div className="flex flex-col gap-2.5" data-testid="cloud-iphone-details">
      <div className="flex items-center gap-2">
        <DeviceMobile size={15} weight="regular" className="shrink-0 text-fg/80" />
        <span className="font-sans text-[12.5px] font-semibold text-fg">ADE Cloud iPhone</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-sans text-[11.5px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-fg">{label}</dt>
            <dd className={cn("min-w-0 text-fg/90 tabular-nums", label === "Idle stop" && warn && "text-warning")}>{value}</dd>
          </div>
        ))}
      </dl>
      {phone.stopNotice ? <p className="font-sans text-[11px] text-warning">{phone.stopNotice}</p> : null}
      <p className="font-sans text-[11px] leading-snug text-muted-fg">
        One phone for the account: every chat that uses ios@cloud drives this one. It stops after 5 minutes with no command or input.
      </p>
      {error ? <p className="font-sans text-[11px] text-error">{error}</p> : null}
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
          Minutes
        </Button>
        {canKeep && !starting ? (
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
