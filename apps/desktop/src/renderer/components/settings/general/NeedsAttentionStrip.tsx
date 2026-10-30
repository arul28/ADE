import React from "react";
import { useNavigate } from "react-router-dom";
import { ArrowClockwise, ArrowRight, CaretDown, CircleNotch, Robot } from "@phosphor-icons/react";
import { confirmDialog } from "../../ui/dialog";
import { showToast } from "../../app/toast/toastStore";
import { AgentLaunchSetup } from "../../shared/AgentLaunchSetup";
import { useProjectFix } from "../health/ProjectIssues";
import type { SettingsTabId } from "../settingsManifest";
// Read only while rendering, so the import cycle with the tab table is safe.
import { STANDALONE_TAB_IDS } from "../settingsTabContent";
import { attentionAgentPrompt, type AttentionItem, type useNeedsAttention } from "../overview/useNeedsAttention";
import "../health/health.css";
import "../overview/overview.css";

const DOT_STATE: Record<AttentionItem["severity"], "crit" | "warn" | undefined> = {
  problem: "crit",
  warning: "warn",
  note: undefined,
};

/**
 * Everything that needs attention, as ONE row at the top of General: a count
 * and the worst state. It opens in place to the list, each item with its fix
 * and a link to its page, and "Ask an agent".
 */
export function NeedsAttentionStrip({
  attention,
  hasProject,
  projectRoot,
}: {
  attention: ReturnType<typeof useNeedsAttention>;
  hasProject: boolean;
  projectRoot: string | null;
}) {
  const navigate = useNavigate();
  const { items, loading, checking } = attention;
  const [open, setOpen] = React.useState(false);
  const [askOpen, setAskOpen] = React.useState(false);
  const [fixingId, setFixingId] = React.useState<string | null>(null);
  // The project's own fixes run on the machine that owns the project: the
  // tab's binding, so unpinned.
  const projectFix = useProjectFix(null, attention.setReport);
  const problems = items.filter((item) => item.severity !== "note").length;
  const worst = items.some((item) => item.severity === "problem")
    ? "crit"
    : items.some((item) => item.severity === "warning") ? "warn" : items.length > 0 ? "note" : "ok";
  // With no project open, a link to a page that needs one would go nowhere.
  const canOpen = (route: string): boolean => {
    if (hasProject) return true;
    const tab = new URL(route, "ade://settings").searchParams.get("tab");
    return tab == null || STANDALONE_TAB_IDS.has(tab as SettingsTabId);
  };

  const runFix = async (item: AttentionItem) => {
    if (item.projectIssue?.fix) {
      await projectFix.runFix(item.projectIssue);
      return;
    }
    const fix = item.fix;
    if (!fix || fixingId) return;
    if (fix.confirm) {
      const ok = await confirmDialog({ title: `${fix.label}?`, message: fix.confirm, confirmLabel: fix.label });
      if (!ok) return;
    }
    setFixingId(item.id);
    try {
      await fix.run();
      showToast({ tone: "success", title: `${fix.label}: done` });
      void attention.reload();
    } catch (err) {
      showToast({ tone: "error", title: `Couldn't ${fix.label.toLowerCase()}`, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setFixingId(null);
    }
  };

  const title = loading
    ? "Checking…"
    : items.length === 0
      ? "Nothing needs attention"
      : problems > 0
        ? (problems === 1 ? "1 thing needs attention" : `${problems} things need attention`)
        : (items.length === 1 ? "1 note" : `${items.length} notes`);
  const expandable = !loading && items.length > 0;

  return (
    <section
      className="ade-gen-attn"
      id="needs-attention"
      data-settings-anchor="needs-attention"
      data-state={worst}
      data-open={open && expandable ? "true" : undefined}
    >
      <div className="ade-gen-attn-head">
        <button
          type="button"
          className="ade-gen-attn-toggle"
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
          onClick={() => setOpen((value) => !value)}
        >
          {loading ? <CircleNotch size={13} className="animate-spin" aria-hidden /> : <span className="kit-dot" data-state={worst === "note" ? undefined : worst} aria-hidden />}
          <span className="ade-gen-attn-title">{title}</span>
          {expandable && !open ? (
            <span className="ade-gen-attn-preview">{items.slice(0, 2).map((item) => item.title).join(" · ")}</span>
          ) : null}
          {expandable ? <CaretDown size={11} weight="bold" className="ade-gen-attn-caret" aria-hidden /> : null}
        </button>
        <button
          type="button"
          className="kit-icon-btn"
          aria-label="Check again"
          title="Check again"
          disabled={loading || checking}
          onClick={() => void attention.reload({ force: true })}
        >
          <ArrowClockwise size={13} className={checking ? "animate-spin" : undefined} />
        </button>
      </div>

      {open && expandable ? (
        <div className="ade-gen-attn-body">
          <ul className="ade-attn-list" aria-label="Needs attention">
            {items.map((item) => {
              const busy = fixingId === item.id || (item.projectIssue?.fix != null && projectFix.fixingId === item.projectIssue.fix.id);
              const fixLabel = item.projectIssue?.fix?.label ?? item.fix?.label ?? null;
              return (
                <li key={item.id} className="ade-attn-row" data-severity={item.severity}>
                  <span className="kit-dot" data-state={DOT_STATE[item.severity]} aria-hidden />
                  <span className="ade-attn-text">
                    <span className="ade-attn-title">{item.title}</span>
                    {item.detail ? <span className="ade-attn-detail" title={item.detail}>{item.detail}</span> : null}
                  </span>
                  <span className="ade-attn-where-col"><span className="kit-tag ade-attn-where">{item.where}</span></span>
                  <span className="ade-attn-fix-col">
                    {fixLabel ? (
                      <button
                        type="button"
                        className="ade-modern-btn"
                        data-size="sm"
                        disabled={busy}
                        title={item.projectIssue?.fix?.description}
                        onClick={() => void runFix(item)}
                      >
                        {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
                        {fixLabel}
                      </button>
                    ) : null}
                  </span>
                  {canOpen(item.route) ? (
                    <button
                      type="button"
                      className="kit-icon-btn ade-attn-open"
                      aria-label={`Open ${item.where} settings for: ${item.title}`}
                      title="Open its page"
                      onClick={() => navigate(item.route)}
                    >
                      <ArrowRight size={13} />
                    </button>
                  ) : <span aria-hidden />}
                </li>
              );
            })}
          </ul>
          {hasProject ? (
            askOpen ? (
              <div className="ade-gen-attn-ask">
                <AgentLaunchSetup
                  defaultPrompt={attentionAgentPrompt(items, projectRoot)}
                  chatTitle="Fix what Settings found"
                  promptLabel="Prompt for the agent"
                  pin={null}
                  projectRoot={projectRoot}
                  onLaunched={() => setAskOpen(false)}
                  onCancel={() => setAskOpen(false)}
                  failureTitle="Couldn't start the agent"
                />
              </div>
            ) : (
              <button type="button" className="ade-modern-btn ade-gen-attn-askbtn" data-variant="ghost" onClick={() => setAskOpen(true)}>
                <Robot size={13} />
                Ask an agent
              </button>
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
