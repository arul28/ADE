import { Clock } from "@phosphor-icons/react";
import type { AutomationTrigger } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { inputCls, labelCls, selectCls } from "../designTokens";
import { describeCron } from "../cronDescribe";

const SCHEDULE_PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Every weekday at 9 AM", cron: "0 9 * * 1-5" },
  { label: "Every day at 9 AM", cron: "0 9 * * *" },
  { label: "Every day at 2 AM", cron: "0 2 * * *" },
  { label: "Every Friday at 4 PM", cron: "0 16 * * 5" },
  { label: "Every hour", cron: "0 * * * *" },
];

export function ScheduleEditor({
  trigger,
  onPatch,
}: {
  trigger: AutomationTrigger;
  onPatch: (patch: Partial<AutomationTrigger>) => void;
}) {
  const cron = trigger.cron ?? "";
  const selectedPreset = SCHEDULE_PRESETS.find((p) => p.cron === cron)?.cron ?? "";
  const gloss = describeCron(cron);
  const unparsed = cron.trim() !== "" && gloss.startsWith("at ");

  return (
    <div className="space-y-2.5">
      <label className="block space-y-1.5">
        <div className={labelCls}>Preset</div>
        <select
          className={selectCls}
          value={selectedPreset}
          onChange={(e) => onPatch({ cron: e.target.value || cron })}
        >
          <option value="">Custom…</option>
          {SCHEDULE_PRESETS.map((p) => (
            <option key={p.cron} value={p.cron}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1.5">
        <div className={labelCls}>Cron expression</div>
        <input
          className={cn(inputCls, "font-mono")}
          value={cron}
          onChange={(e) => onPatch({ cron: e.target.value })}
          placeholder="0 9 * * 1-5"
          spellCheck={false}
        />
      </label>
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px]",
          unparsed
            ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
            : "border-accent/20 bg-accent/[0.06] text-fg/85",
        )}
      >
        <Clock size={12} weight="regular" className={unparsed ? "text-amber-300" : "text-accent"} />
        <span>{unparsed ? `Couldn't read that — runs ${gloss}` : `Runs ${gloss}`}</span>
      </div>
    </div>
  );
}
