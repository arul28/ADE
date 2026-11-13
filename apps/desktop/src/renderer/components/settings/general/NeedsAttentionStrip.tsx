import React from "react";
import { useNavigate } from "react-router-dom";
import { ArrowClockwise, ArrowRight, CaretDown, CaretRight, CircleNotch, Info, Robot, WarningCircle, XCircle } from "@phosphor-icons/react";
import { pluralCount } from "../../../../shared/formatting";
import { confirmDialog } from "../../ui/dialog";
import { showToast } from "../../app/toast/toastStore";
import { AgentLaunchSetup } from "../../shared/AgentLaunchSetup";
import { useProjectFix } from "../health/ProjectIssues";
import type { SettingsTabId } from "../settingsManifest";
// Read only while rendering, so the import cycle with the tab table is safe.
import { STANDALONE_TAB_IDS } from "../settingsTabContent";
import { attentionAgentPrompt, attentionLines, type AttentionItem, type useNeedsAttention } from "../overview/useNeedsAttention";
import "../health/health.css";
import "../overview/overview.css";

// The notice tones' glyphs (`defaultNoticeIcon`); a note stays outlined and quiet.
const SEVERITY_ICON: Record<AttentionItem["severity"], React.ReactNode> = {
  problem: <XCircle size={15} weight="fill" aria-hidden />,
  warning: <WarningCircle size={15} weight="fill" aria-hidden />,
  note: <Info size={15} aria-hidden />,
};

const SEVERITY_LABEL: Record<AttentionItem["severity"], string> = {
  problem: "Problem",
  warning: "Needs a look",
  note: "Note",
};

/** One row: what is wrong, where, its lines (folded), its fix and its page. */
function AttentionRow({
  item,
  busy,
  canOpen,
  onFix,
  onOpen,
}: {
  item: AttentionItem;
  busy: boolean;
  canOpen: boolean;
  onFix: () => void;
  onOpen: () => void;
}) {
  const [linesOpen, setLinesOpen] = React.useState(false);
  const fixLabel = item.projectIssue?.fix?.label ?? item.fix?.label ?? null;
  const lines = attentionLines(item);
  return (
    <li className="ade-attn-row" data-severity={item.severity}>
      <span className="ade-attn-icon" title={SEVERITY_LABEL[item.severity]}>{SEVERITY_ICON[item.severity]}</span>
      <div className="ade-attn-text">
        <span className="ade-attn-title">{item.title}</span>
        <span className="ade-attn-meta">
          <span className="ade-attn-where">{item.where}</span>
          {item.detail ? <span className="ade-attn-detail">{item.detail}</span> : null}
        </span>
        {lines.length > 0 ? (
          <>
            <button
              type="button"
              className="ade-attn-lines-toggle"
              aria-expanded={linesOpen}
              onClick={() => setLinesOpen((value) => !value)}
            >
              <CaretRight size={10} weight="bold" className="ade-attn-lines-caret" aria-hidden />
              {linesOpen ? "Hide details" : `Show ${pluralCount(lines.length, "detail")}`}
            </button>
            {linesOpen ? (
              <ul className="ade-attn-lines">
                {lines.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
      <span className="ade-attn-actions">
        {fixLabel ? (
          <button
            type="button"
            className="ade-modern-btn"
            data-size="sm"
            disabled={busy}
            title={item.projectIssue?.fix?.description}
            onClick={onFix}
          >
            {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
            {fixLabel}
          </button>
        ) : null}
        {canOpen ? (
          <button
            type="button"
            className="kit-icon-btn ade-attn-open"
            aria-label={`Open ${item.where} settings for: ${item.title}`}
            title="Open its page"
            onClick={onOpen}
          >
            <ArrowRight size={13} />
          </button>
        ) : null}
      </span>
    </li>
  );
}

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
  // The project's own fixes run on the copy the checks were read from.
  const projectFix = useProjectFix(attention.projectPin, attention.setReport);
  const needs = items.filter((item) => item.severity !== "note");
  const notes = items.filter((item) => item.severity === "note");
  const worst = items.some((item) => item.severity === "problem")
    ? "crit"
    : needs.length > 0 ? "warn" : notes.length > 0 ? "note" : "ok";
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
      : needs.length > 0
        ? `${pluralCount(needs.length, "thing needs", "things need")} attention`
        : pluralCount(notes.length, "note");
  // Notes are counted beside the title, so the header and the list agree.
  const subtitle = !loading && needs.length > 0 && notes.length > 0 ? pluralCount(notes.length, "note") : null;
  const expandable = !loading && items.length > 0;

  const renderRow = (item: AttentionItem) => (
    <AttentionRow
      key={item.id}
      item={item}
      busy={fixingId === item.id || (item.projectIssue?.fix != null && projectFix.fixingId === item.projectIssue.fix.id)}
      canOpen={canOpen(item.route)}
      onFix={() => void runFix(item)}
      onOpen={() => navigate(item.route)}
    />
  );

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
          {subtitle ? <span className="ade-gen-attn-sub">· {subtitle}</span> : null}
          {expandable && !open ? (
            <span className="ade-gen-attn-preview">{(needs.length > 0 ? needs : notes).slice(0, 2).map((item) => item.title).join(" · ")}</span>
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
          {needs.length > 0 ? (
            <ul className="ade-attn-list" aria-label="Needs attention">{needs.map(renderRow)}</ul>
          ) : null}
          {notes.length > 0 ? (
            <>
              {needs.length > 0 ? <div className="ade-attn-group-label">Good to know</div> : null}
              <ul className="ade-attn-list" data-kind="notes" aria-label="Notes">{notes.map(renderRow)}</ul>
            </>
          ) : null}
          {hasProject && attention.projectPin ? (
            askOpen ? (
              <div className="ade-gen-attn-ask">
                <AgentLaunchSetup
                  defaultPrompt={attentionAgentPrompt(items, projectRoot)}
                  chatTitle="Fix what Settings found"
                  promptLabel="Prompt for the agent"
                  pin={attention.projectPin}
                  projectRoot={attention.projectPin ? null : projectRoot}
                  onLaunched={() => setAskOpen(false)}
                  onCancel={() => setAskOpen(false)}
                  failureTitle="Couldn't start the agent"
                />
              </div>
            ) : (
              <button type="button" className="ade-modern-btn ade-gen-attn-askbtn" data-variant="ghost" onClick={() => setAskOpen(true)}>
                <Robot size={13} />
                Ask an agent to go through these
              </button>
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
