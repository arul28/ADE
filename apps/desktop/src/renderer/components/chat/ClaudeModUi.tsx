import { memo, useCallback, useId, useRef, type CSSProperties } from "react";
import { CaretDown, X } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import {
  CLAUDE_PLUGIN_UI_BAND_COLUMNS,
  CLAUDE_PLUGIN_UI_BAND_ROWS,
  CLAUDE_PLUGIN_UI_PANE_ROWS,
  claudePluginUiHasContent,
  type ClaudePluginUiAction,
  type ClaudePluginUiSite,
} from "../../../shared/claudePluginUi";
import { INERT_ATTR } from "../shared/inertAttr";
import { ModTree } from "./ClaudeModTree";
import { setClaudeModUiCollapsed, useClaudeModUiCollapsed } from "./claudeModUiPrefs";
import { claudeModUiApi, useClaudeModUi } from "./claudeModUiStore";
import "./ClaudeModUi.css";

const BAND_SITE: ClaudePluginUiSite = { component: "AbovePrompt" };
/** For the CSS: the cell grid the host asked mods to lay out for. */
const GRID_STYLE = {
  "--ade-mod-columns": CLAUDE_PLUGIN_UI_BAND_COLUMNS,
  "--ade-mod-band-rows": CLAUDE_PLUGIN_UI_BAND_ROWS,
  "--ade-mod-pane-rows": CLAUDE_PLUGIN_UI_PANE_ROWS,
} as CSSProperties;

/**
 * Draws what Claude Code mods put on screen for one chat, as one dock that sits
 * on the prompt box: a header with the mods' status lines, and under it the
 * open panes and the band a mod draws above the prompt. The header folds the
 * dock down to one row. Toasts are raised by the store.
 *
 * Mods lay out in terminal cells, so every tree is monospace and sized in `ch`.
 * A control acts only while the Claude process that drew it lives.
 */
export const ClaudeModUi = memo(function ClaudeModUi(props: {
  sessionId: string | null;
  pin: OpenProjectBinding | null | undefined;
}) {
  const { sessionId, pin } = props;
  const snapshot = useClaudeModUi(sessionId, pin);
  const collapsed = useClaudeModUiCollapsed();
  const bodyId = useId();
  const pinRef = useRef(pin);
  pinRef.current = pin;

  const { generation, live } = snapshot;
  const act = useCallback((action: ClaudePluginUiAction) => {
    const api = claudeModUiApi();
    if (!api || !sessionId || !live) return;
    void api.act({ sessionId, generation, ...action }, pinRef.current ?? null).catch(() => {
      // The process that drew the control is gone; the next snapshot says so.
    });
  }, [sessionId, generation, live]);

  if (!sessionId || !claudePluginUiHasContent(snapshot)) return null;

  // Status lines alone are one row: there is nothing to fold away.
  const hasBody = snapshot.band !== null || snapshot.panes.length > 0;
  const folded = hasBody && collapsed;
  const Head = hasBody ? "button" : "div";

  return (
    <div
      className="ade-mod-ui"
      style={GRID_STYLE}
      data-live={live ? "true" : "false"}
      data-collapsed={folded ? "true" : "false"}
      data-testid="claude-mod-ui"
    >
      <div className="kit-card">
        <Head
          className="kit-card-head ade-mod-head"
          data-compact="true"
          {...(hasBody
            ? {
                type: "button",
                "aria-expanded": !folded,
                "aria-controls": bodyId,
                title: folded ? "Show what your Claude mods draw" : "Hide what your Claude mods draw",
                onClick: () => setClaudeModUiCollapsed(!collapsed),
              }
            : null)}
        >
          <span className="kit-eyebrow">Mods</span>
          <span className="ade-mod-statuses">
            {snapshot.statuses.map((status) => (
              // Claude Code starts a status line with the name of the mod that set it.
              <span key={status.plugin} className="ade-mod-status">
                <span className="ade-mod-status-name">{status.plugin}</span> {status.text}
              </span>
            ))}
          </span>
          {hasBody ? <CaretDown size={11} weight="bold" className="ade-mod-caret" aria-hidden /> : null}
        </Head>
        {hasBody ? (
          // Folded, the body is out of the tab order and hidden from assistive tools.
          <div id={bodyId} className="ade-mod-body" {...(folded ? INERT_ATTR : null)}>
            <div className="ade-mod-body-inner">
              {snapshot.panes.map((pane) => (
                <section key={pane.id} className="ade-mod-pane">
                  <header className="ade-mod-pane-head">
                    <span className="ade-mod-pane-title">{pane.title}</span>
                    {pane.plugin ? <span className="ade-mod-pane-plugin">{pane.plugin}</span> : null}
                    <button
                      type="button"
                      className="kit-icon-btn ade-mod-pane-close"
                      aria-label={`Close ${pane.title}`}
                      title="Close"
                      disabled={!live}
                      onClick={() => act({ kind: "closePane", paneId: pane.id })}
                    >
                      <X size={12} />
                    </button>
                  </header>
                  {pane.tree ? (
                    <div className="ade-mod-surface ade-mod-pane-body">
                      <div className="ade-mod-fit">
                        <ModTree node={pane.tree} site={{ component: "Pane", paneId: pane.id }} act={act} live={live} />
                      </div>
                    </div>
                  ) : null}
                </section>
              ))}
              {snapshot.band ? (
                <div className="ade-mod-surface ade-mod-band">
                  <div className="ade-mod-fit">
                    <ModTree node={snapshot.band} site={BAND_SITE} act={act} live={live} />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});
