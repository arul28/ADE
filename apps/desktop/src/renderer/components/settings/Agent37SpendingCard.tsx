import { useCallback, useEffect, useState } from "react";
import { Wallet } from "@phosphor-icons/react";
import {
  AGENT37_BILLING_URL,
  AGENT37_CAP_CHOICES_USD,
  formatAgent37Usd,
  type Agent37Budget,
  type Agent37MachinesResult,
} from "../../../shared/agent37";
import { IntegrationCard } from "./integrations/IntegrationChrome";
import { Banner } from "../ui/notice";
import { ipcErrorMessage } from "../../lib/format";
import { agent37GroupTotals } from "../remoteTargets/agent37MachineModel";

/** "about 3 days" / "about 20 hours" at this rate, or null when nothing bills. */
function walletRunway(balanceUsd: number | null, hourlyUsd: number): string | null {
  if (balanceUsd == null || hourlyUsd <= 0) return null;
  const hours = balanceUsd / hourlyUsd;
  if (hours >= 24 * 60) return "60+ days";
  return hours >= 48 ? `${Math.floor(hours / 24)} days` : `${Math.max(1, Math.floor(hours))} hours`;
}

/**
 * Settings › Integrations › Agent 37 › Spending: this month against the cap,
 * what sleeping saved, how long the wallet lasts, and the cap itself.
 * Account-wide (the cap is in the account vault, the spend on Agent 37), so it
 * asks this desktop's main process with no pin.
 */
export function Agent37SpendingCard() {
  const bridge = window.ade.agent37;
  const [machines, setMachines] = useState<Agent37MachinesResult | null>(null);
  const [budget, setBudget] = useState<Agent37Budget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!bridge?.listMachines || !bridge.getBudget) return;
    try {
      const [list, cap] = await Promise.all([bridge.listMachines(), bridge.getBudget()]);
      setMachines(list);
      setBudget(cap);
    } catch (loadError) {
      setError(ipcErrorMessage(loadError) || "Couldn't read your Agent 37 spending.");
    }
  }, [bridge]);

  useEffect(() => {
    void load();
    const off = bridge?.onStatusChanged?.(() => { void load(); });
    return () => off?.();
  }, [bridge, load]);

  if (!bridge?.listMachines || !bridge.getBudget || !bridge.setBudget) return null;
  const setCap = bridge.setBudget;

  const save = async (monthlyCapUsd: number | null) => {
    setBusy(true);
    setError(null);
    try {
      const next = await setCap({ monthlyCapUsd });
      if (next) setBudget(next);
      void load();
    } catch (saveError) {
      setError(ipcErrorMessage(saveError) || "Couldn't save the cap.");
    } finally {
      setBusy(false);
    }
  };

  const spending = machines?.state === "ok" ? machines.spending : null;
  const totals = machines?.state === "ok" ? agent37GroupTotals(machines.machines) : null;
  const cap = budget?.monthlyCapUsd ?? null;
  const tag = spending?.capReached
    ? { label: "At the cap", tone: "warn" as const }
    : spending?.capNear
      ? { label: "Near the cap", tone: "warn" as const }
      : cap != null
        ? { label: `${formatAgent37Usd(cap)} a month`, tone: undefined }
        : { label: "No cap", tone: undefined };
  const runway = totals ? walletRunway(machines?.balanceUsd ?? null, totals.hourlyUsd) : null;
  const choices: Array<{ value: number | null; label: string }> = [
    ...AGENT37_CAP_CHOICES_USD.map((usd) => ({ value: usd as number | null, label: `$${usd}` })),
    { value: null, label: "Off" },
  ];

  return (
    <IntegrationCard
      anchor="agent37-spending"
      span="full"
      icon={<Wallet size={15} weight="fill" />}
      title="Spending"
      badge={<span className="kit-tag" data-tone={tag.tone}>{tag.label}</span>}
      hint="Machines sleep after a few idle minutes and bill only their disk. At the cap ADE makes and wakes nothing new."
    >
      <div className="ade-ig-figures">
        <div className="ade-ig-figure">
          <span className="kit-eyebrow">This month</span>
          <b>
            {spending?.monthSpentUsd != null ? formatAgent37Usd(spending.monthSpentUsd) : "—"}
            <small>{cap != null ? `of ${formatAgent37Usd(cap)}` : "no cap"}</small>
          </b>
        </div>
        <div className="ade-ig-figure" title="What the hours your machines spent asleep would have cost awake. Agent 37 settles compute hourly.">
          <span className="kit-eyebrow">Saved asleep</span>
          <b>{totals?.savedUsd != null ? formatAgent37Usd(totals.savedUsd) : "—"}<small>so far</small></b>
        </div>
        <div className="ade-ig-figure">
          <span className="kit-eyebrow">Wallet lasts</span>
          <b>{runway ?? "—"}<small>{runway ? "at this rate" : "nothing billing"}</small></b>
        </div>
      </div>

      <div className="ade-ig-field">
        <span className="ade-ig-field-label">Monthly cap</span>
        <div className="ade-ig-field-controls">
          <div className="kit-seg" data-case="sentence" role="radiogroup" aria-label="Monthly cap" aria-disabled={busy || undefined}>
            {choices.map((choice) => (
              <button
                key={choice.label}
                type="button"
                role="radio"
                aria-checked={choice.value === cap}
                disabled={busy || budget == null}
                onClick={() => { if (choice.value !== cap) void save(choice.value); }}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {spending?.capReached ? (
        <Banner
          layout="inline"
          model={{
            id: "agent37-spending-cap",
            tone: "warning",
            title: "At this month's cap",
            detail: "ADE won't make, wake or resize machines until you raise the cap or the month ends. Running work carries on.",
          }}
        />
      ) : null}
      {runway && totals && machines?.balanceUsd != null && machines.balanceUsd / totals.hourlyUsd < 72 ? (
        <Banner
          layout="inline"
          model={{
            id: "agent37-spending-wallet",
            tone: "warning",
            title: "Your wallet is running low",
            detail: `${formatAgent37Usd(machines.balanceUsd)} lasts about ${runway} at this rate. When it runs out, Agent 37 suspends your machines.`,
            actions: [{ label: "Top up", href: AGENT37_BILLING_URL }],
          }}
        />
      ) : null}
      {error ? (
        <Banner layout="inline" model={{ id: "agent37-spending-error", tone: "error", title: "Spending", detail: error, actions: [{ label: "Dismiss", onClick: () => setError(null) }] }} />
      ) : null}
    </IntegrationCard>
  );
}
