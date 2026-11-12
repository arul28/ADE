import type { TerminalResumeLaunchConfig } from "../../../shared/types";
import { ModelRowLogo } from "../shared/ProviderLogos";
import { resolveModelDescriptorWithRuntimeCatalog, createUnknownModelPlaceholder } from "../shared/ModelPicker/modelCatalog";

export function cliPermissionLabel(launch: TerminalResumeLaunchConfig | null): string | null {
  if (launch?.codexApprovalPolicy === "on-request") return "Ask first";
  if (launch?.codexApprovalPolicy === "on-failure") return "On failure";
  if (launch?.codexApprovalPolicy === "untrusted") return "Restricted";
  if (launch?.codexApprovalPolicy === "never" && launch.codexSandbox === "danger-full-access") return "Full access";
  const mode = launch?.permissionMode;
  if (mode === "full-auto") return "Full access";
  if (mode === "plan") return "Plan";
  if (mode === "edit") return "Edit";
  if (mode === "auto") return "Auto";
  if (mode === "config-toml") return "Config";
  if (mode === "default") return "Default";
  return null;
}

/**
 * The chat composer's model pill, effort and permission, for a CLI: what the
 * CLI was launched (or last relaunched by ADE) with. Read-only; a change made
 * inside the CLI itself (its own `/model`) is not something ADE can see.
 */
export function CliLaunchChips({
  launch,
  providerLabel,
}: {
  launch: TerminalResumeLaunchConfig | null;
  providerLabel: string;
}) {
  const modelId = launch?.model?.trim() || null;
  const modelDescriptor = modelId
    ? (resolveModelDescriptorWithRuntimeCatalog(modelId) ?? createUnknownModelPlaceholder(modelId))
    : null;
  const permissionLabel = cliPermissionLabel(launch);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {modelDescriptor ? (
        <span className="inline-flex min-w-0 max-w-[min(12rem,42vw)] items-center gap-1.5 rounded-md border border-fg/[0.06] bg-fg/[0.03] px-2 py-1 text-[11px] text-fg/80">
          <ModelRowLogo
            modelFamily={modelDescriptor.family}
            cliCommand={modelDescriptor.cliCommand}
            modelId={modelDescriptor.id}
            providerModelId={modelDescriptor.providerModelId}
            size={13}
            className="shrink-0"
          />
          <span className="min-w-0 truncate font-medium leading-none">{modelDescriptor.displayName}</span>
        </span>
      ) : (
        <span className="min-w-0 shrink truncate px-1 text-[11px] font-medium text-fg/70">{providerLabel}</span>
      )}
      {launch?.reasoningEffort ? (
        <span className="rounded-md border border-fg/[0.06] bg-fg/[0.03] px-1.5 py-1 text-[10px] font-semibold uppercase text-fg/65">
          {launch.reasoningEffort}
        </span>
      ) : null}
      {(launch?.fastMode ?? launch?.codexFastMode) ? (
        <span className="rounded-md border border-amber-300/15 bg-amber-500/[0.06] px-1.5 py-1 text-[10px] font-semibold text-amber-100/80">
          Fast
        </span>
      ) : null}
      {permissionLabel ? (
        <span className="rounded-md border border-fg/[0.06] bg-fg/[0.03] px-1.5 py-1 text-[10px] text-fg/60">
          {permissionLabel}
        </span>
      ) : null}
    </div>
  );
}
