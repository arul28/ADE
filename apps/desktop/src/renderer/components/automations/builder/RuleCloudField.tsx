import type { AutomationCloudTarget } from "../../../../shared/types";
import { cloudTierRateLabel } from "../../../../shared/cloudTiers";
import { cn } from "../../ui/cn";
import { SettingsToggle } from "../../settings/settingsSectionUi";
import { CloudMark, CloudSizeIcon } from "../../remoteTargets/cloudBrand";
import { useAdeCloudEnabled } from "../../../state/cloudAccess";
import { useAdeCloudDraft } from "../../chat/useAdeCloudDraft";
import { inputCls } from "../designTokens";

/**
 * "Run on ADE Cloud", beside "Runs on [machine]": each run makes its lane on
 * its own new ADE Cloud computer. The machine above still watches the
 * trigger and keeps the run history. Listed only when the account has ADE
 * Cloud, or when the rule already uses it (so it can be turned off).
 *
 * The sizes come from the one shared cloud read (`useCloudMachines`), only
 * while this field is on screen.
 */
export function RuleCloudField({
  value,
  onChange,
  problem,
  disabled = false,
}: {
  value: AutomationCloudTarget | null;
  onChange: (next: AutomationCloudTarget | null) => void;
  /** Why the rule can't run on ADE Cloud as it is (`automationCloudProblem`), or null. */
  problem: string | null;
  disabled?: boolean;
}) {
  const cloudEnabled = useAdeCloudEnabled();
  const on = value != null;
  const cloud = useAdeCloudDraft({ enabled: cloudEnabled && on, originUrl: null });
  if (!cloudEnabled && !on) return null;
  const pickedSize = value?.sizeId ?? null;
  const defaultTier = cloud.tiers.find((tier) => tier.id === cloud.defaultTier) ?? null;
  const shownTier = pickedSize ?? defaultTier?.id ?? cloud.defaultTier;
  return (
    <div className="mb-3 rounded-md border border-fg/[0.06] bg-fg/[0.02] px-3 py-2" data-testid="automation-cloud-field">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-start gap-2">
          <CloudMark size={13} brand className="mt-0.5" />
          <span className="min-w-0">
            <span className="block text-[11.5px] text-fg/90">Run on ADE Cloud</span>
            <span className="mt-0.5 block text-[10.5px] text-muted-fg/60">
              {on
                ? "Each run gets a new lane on its own computer. The machine above still watches the trigger and keeps the history."
                : "Give each run a new lane on its own ADE Cloud computer."}
            </span>
          </span>
        </span>
        <SettingsToggle
          id="automation-run-on-ade-cloud"
          label="Run on ADE Cloud"
          checked={on}
          disabled={disabled || (!cloudEnabled && !on)}
          onChange={(next) => onChange(next ? {} : null)}
        />
      </div>
      {on ? (
        <div className="mt-2 space-y-1.5 border-t border-fg/[0.05] pt-2">
          <label className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[11px] text-muted-fg/70">Size</span>
            <span className="relative flex min-w-0 flex-1 items-center">
              <span className="pointer-events-none absolute left-2 text-muted-fg/70">
                <CloudSizeIcon tier={shownTier} size={13} />
              </span>
              <select
                className={cn(inputCls, "h-7 min-w-0 flex-1 pl-7")}
                value={pickedSize ?? ""}
                disabled={disabled}
                aria-label="Size of each run's ADE Cloud computer"
                onChange={(event) => {
                  const next = cloud.tiers.find((tier) => tier.id === event.target.value)?.id ?? null;
                  onChange(next ? { sizeId: next } : {});
                }}
              >
                <option value="">Your default{defaultTier ? ` (${defaultTier.label})` : ""}</option>
                {cloud.tiers.map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {tier.label}: {tier.cpu} CPU, {tier.memoryGb} GB, {cloudTierRateLabel(tier)}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <p className="text-[10.5px] text-muted-fg/60">
            Nobody watches a run, so it counts as an agent: your agent limits set its largest size and how many new
            computers it may start a day.
          </p>
          {!cloudEnabled ? (
            <p className="text-[10.5px] text-amber-300/80">ADE Cloud isn't available on this account. Turn this off to run here.</p>
          ) : null}
          {problem ? (
            <p className="text-[10.5px] text-amber-300/80" data-testid="automation-cloud-problem">{problem}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
