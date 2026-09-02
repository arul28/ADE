/**
 * The package's entire stylesheet, as a string.
 *
 * It is plain CSS against `--adechat-*` tokens — no Tailwind, no CSS modules,
 * no build-step CSS import for consumers to wire up. Hosts either render
 * `<AdeChatStyles />` (the default, and what `<AdeChat>` does for you) or call
 * `injectAdeChatStyles()` once at startup.
 *
 * Class names are prefixed `adechat-` and are not a public API; theme with
 * tokens, not by overriding these rules.
 */

import { defaultTheme, themeToCss } from "./createTheme";

const ADE_CHAT_STYLE_ID = "adechat-styles";

export const adeChatCss = `
${themeToCss(defaultTheme, ".adechat-root")}

.adechat-root {
  display: flex;
  flex-direction: column;
  min-height: 0;
  color: var(--adechat-fg);
  background: var(--adechat-bg);
  font-family: var(--adechat-font);
  font-size: var(--adechat-font-size);
  line-height: 1.5;
  box-sizing: border-box;
}
.adechat-root *,
.adechat-root *::before,
.adechat-root *::after { box-sizing: inherit; }

/* Transcript ------------------------------------------------------------- */

.adechat-transcript {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: calc(var(--adechat-space) * 1.5);
  padding: calc(var(--adechat-space) * 2);
}
.adechat-transcript-empty {
  margin: auto;
  color: var(--adechat-muted);
  text-align: center;
  padding: calc(var(--adechat-space) * 3);
}

.adechat-row { display: flex; flex-direction: column; }
.adechat-row-user { align-items: flex-end; }

.adechat-bubble-user {
  max-width: 82%;
  padding: calc(var(--adechat-space) * 0.875) calc(var(--adechat-space) * 1.25);
  border-radius: var(--adechat-radius);
  background: var(--adechat-accent);
  color: var(--adechat-accent-fg);
  white-space: pre-wrap;
  word-break: break-word;
}
.adechat-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--adechat-space) * 0.5);
  margin-top: calc(var(--adechat-space) * 0.5);
}
.adechat-attachment {
  font-size: 0.8em;
  padding: 2px 8px;
  border-radius: var(--adechat-radius-sm);
  border: 1px solid var(--adechat-border);
  color: var(--adechat-muted);
}

.adechat-assistant {
  max-width: 100%;
  word-break: break-word;
}
.adechat-assistant > :first-child { margin-top: 0; }
.adechat-assistant > :last-child { margin-bottom: 0; }
.adechat-assistant p { margin: 0 0 0.75em; }
.adechat-assistant h1,
.adechat-assistant h2,
.adechat-assistant h3 { margin: 1em 0 0.4em; line-height: 1.25; }
.adechat-assistant h1 { font-size: 1.35em; }
.adechat-assistant h2 { font-size: 1.2em; }
.adechat-assistant h3 { font-size: 1.05em; }
.adechat-assistant ul,
.adechat-assistant ol { margin: 0 0 0.75em; padding-left: 1.4em; }
.adechat-assistant li { margin: 0.15em 0; }
.adechat-assistant a { color: var(--adechat-accent); }
.adechat-assistant blockquote {
  margin: 0 0 0.75em;
  padding-left: calc(var(--adechat-space) * 1.25);
  border-left: 2px solid var(--adechat-border-strong);
  color: var(--adechat-muted);
}
.adechat-assistant hr {
  border: 0;
  border-top: 1px solid var(--adechat-border);
  margin: 1em 0;
}
.adechat-code-inline {
  font-family: var(--adechat-font-mono);
  font-size: 0.9em;
  padding: 1px 5px;
  border-radius: var(--adechat-radius-sm);
  background: var(--adechat-bg-raised);
}
.adechat-code-block {
  font-family: var(--adechat-font-mono);
  font-size: 0.88em;
  margin: 0 0 0.75em;
  padding: calc(var(--adechat-space) * 1.25);
  border-radius: var(--adechat-radius);
  border: 1px solid var(--adechat-border);
  background: var(--adechat-bg-subtle);
  overflow-x: auto;
  white-space: pre;
}

/* Reasoning -------------------------------------------------------------- */

.adechat-reasoning { align-self: stretch; }
.adechat-reasoning-toggle {
  display: inline-flex;
  align-items: center;
  gap: calc(var(--adechat-space) * 0.5);
  font: inherit;
  font-size: 0.88em;
  color: var(--adechat-muted);
  background: none;
  border: 0;
  padding: 2px 0;
  cursor: pointer;
}
.adechat-reasoning-toggle:hover { color: var(--adechat-fg); }
.adechat-reasoning-body {
  margin-top: calc(var(--adechat-space) * 0.75);
  padding: calc(var(--adechat-space) * 1.25);
  border-radius: var(--adechat-radius);
  border: 1px solid var(--adechat-border);
  background: var(--adechat-bg-subtle);
  color: var(--adechat-muted);
  white-space: pre-wrap;
  font-size: 0.92em;
}

/* Tool chips ------------------------------------------------------------- */

.adechat-chip {
  align-self: flex-start;
  max-width: 100%;
  border: 1px solid var(--adechat-border);
  border-radius: var(--adechat-radius);
  background: var(--adechat-bg-subtle);
  overflow: hidden;
}
.adechat-chip-head {
  display: flex;
  align-items: center;
  gap: calc(var(--adechat-space) * 0.75);
  width: 100%;
  font: inherit;
  font-size: 0.88em;
  text-align: left;
  color: var(--adechat-fg);
  background: none;
  border: 0;
  padding: calc(var(--adechat-space) * 0.625) calc(var(--adechat-space) * 1.25);
  cursor: pointer;
}
.adechat-chip-head:hover { background: var(--adechat-hover); }
.adechat-chip-head[aria-disabled="true"] { cursor: default; }
.adechat-chip-head[aria-disabled="true"]:hover { background: none; }
.adechat-chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.adechat-chip-elapsed { color: var(--adechat-muted); font-variant-numeric: tabular-nums; }
.adechat-chip-icon { display: inline-flex; flex: 0 0 auto; }
.adechat-chip-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--adechat-muted);
}
.adechat-chip-dot[data-status="running"] {
  background: var(--adechat-accent);
  animation: adechat-pulse 1.4s ease-in-out infinite;
}
.adechat-chip-dot[data-status="failed"] { background: var(--adechat-danger); }
.adechat-chip-dot[data-status="completed"] { background: var(--adechat-success); }
.adechat-chip-body {
  border-top: 1px solid var(--adechat-border);
  padding: calc(var(--adechat-space) * 1.25);
  display: flex;
  flex-direction: column;
  gap: calc(var(--adechat-space) * 0.75);
}
.adechat-chip-section-label {
  font-size: 0.75em;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--adechat-muted);
  margin-bottom: 4px;
}
.adechat-chip-pre {
  font-family: var(--adechat-font-mono);
  font-size: 0.85em;
  margin: 0;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--adechat-muted);
}

/* Errors ----------------------------------------------------------------- */

.adechat-error {
  align-self: stretch;
  border: 1px solid var(--adechat-danger);
  background: var(--adechat-danger-subtle);
  border-radius: var(--adechat-radius);
  padding: calc(var(--adechat-space) * 1.25);
}
.adechat-error-message { font-weight: 600; }
.adechat-error-detail {
  margin: calc(var(--adechat-space) * 0.5) 0 0;
  font-family: var(--adechat-font-mono);
  font-size: 0.85em;
  white-space: pre-wrap;
  color: var(--adechat-muted);
}

/* Approvals -------------------------------------------------------------- */

.adechat-approval {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: calc(var(--adechat-space) * 0.75);
  padding: calc(var(--adechat-space) * 1.25);
  border: 1px solid var(--adechat-border-strong);
  border-radius: var(--adechat-radius);
  background: var(--adechat-bg-subtle);
}
.adechat-approval[data-state="pending"] { border-color: var(--adechat-accent); }
.adechat-approval[data-state="rejected"],
.adechat-approval[data-state="cancelled"] { border-color: var(--adechat-border); }
.adechat-approval[data-state="expired"] { border-color: var(--adechat-border); opacity: 0.75; }
.adechat-approval-head {
  display: flex;
  align-items: baseline;
  gap: calc(var(--adechat-space) * 0.75);
}
.adechat-approval-title { font-weight: 600; flex: 1 1 auto; }
.adechat-approval-settled { font-size: 0.85em; color: var(--adechat-muted); }
.adechat-approval-command {
  margin: 0;
  padding: calc(var(--adechat-space) * 0.75) calc(var(--adechat-space) * 1);
  border-radius: var(--adechat-radius-sm);
  background: var(--adechat-bg);
  border: 1px solid var(--adechat-border);
  font-family: var(--adechat-font-mono);
  font-size: 0.85em;
  white-space: pre-wrap;
  overflow-x: auto;
}
.adechat-approval-path { margin: 0; font-family: var(--adechat-font-mono); font-size: 0.85em; }
.adechat-approval-note { margin: 0; font-size: 0.88em; color: var(--adechat-muted); }
.adechat-approval-error { margin: 0; font-size: 0.88em; color: var(--adechat-danger); }
.adechat-approval-actions {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--adechat-space) * 0.75);
}
/* The card never takes focus, so reaching it by keyboard has to be visible. */
.adechat-approval-actions .adechat-button:focus-visible {
  outline: 2px solid var(--adechat-accent);
  outline-offset: 2px;
}

/* Live activity ---------------------------------------------------------- */

.adechat-activity {
  display: flex;
  align-items: center;
  gap: calc(var(--adechat-space) * 0.75);
  color: var(--adechat-muted);
  font-size: 0.9em;
}
.adechat-activity-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--adechat-accent);
  animation: adechat-pulse 1.4s ease-in-out infinite;
}

@keyframes adechat-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* Composer --------------------------------------------------------------- */

.adechat-composer {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: calc(var(--adechat-space) * 0.75);
  padding: calc(var(--adechat-space) * 1.5);
  border-top: 1px solid var(--adechat-border);
  background: var(--adechat-bg);
}
.adechat-composer-surface {
  display: flex;
  flex-direction: column;
  gap: calc(var(--adechat-space) * 0.75);
  padding: calc(var(--adechat-space) * 1);
  border: 1px solid var(--adechat-border);
  border-radius: var(--adechat-radius);
  background: var(--adechat-bg-subtle);
}
.adechat-composer-surface:focus-within { border-color: var(--adechat-border-strong); }
.adechat-composer-input {
  font: inherit;
  color: var(--adechat-fg);
  background: none;
  border: 0;
  outline: none;
  resize: none;
  width: 100%;
  min-height: 22px;
  max-height: 40vh;
  overflow-y: auto;
}
.adechat-composer-input::placeholder { color: var(--adechat-muted); }
.adechat-composer-input:disabled { opacity: 0.6; cursor: not-allowed; }
.adechat-composer-actions {
  display: flex;
  align-items: center;
  gap: calc(var(--adechat-space) * 0.75);
}
.adechat-composer-rail { display: flex; align-items: center; gap: calc(var(--adechat-space) * 0.5); min-width: 0; }
.adechat-composer-spacer { flex: 1 1 auto; }
.adechat-composer-hint { color: var(--adechat-muted); font-size: 0.8em; }
.adechat-composer-error { color: var(--adechat-danger); font-size: 0.85em; }

.adechat-button {
  display: inline-flex;
  align-items: center;
  gap: calc(var(--adechat-space) * 0.5);
  font: inherit;
  font-size: 0.9em;
  padding: calc(var(--adechat-space) * 0.625) calc(var(--adechat-space) * 1.25);
  border-radius: var(--adechat-radius-sm);
  border: 1px solid var(--adechat-border);
  background: var(--adechat-bg-raised);
  color: var(--adechat-fg);
  cursor: pointer;
}
.adechat-button:hover:not(:disabled) { background: var(--adechat-hover); }
.adechat-button:disabled { opacity: 0.45; cursor: not-allowed; }
.adechat-button[data-variant="primary"] {
  background: var(--adechat-accent);
  border-color: var(--adechat-accent);
  color: var(--adechat-accent-fg);
}
.adechat-button[data-variant="danger"] {
  background: var(--adechat-danger-subtle);
  border-color: var(--adechat-danger);
  color: var(--adechat-danger);
}
.adechat-button-icon { padding: calc(var(--adechat-space) * 0.625); }

/* Model picker ----------------------------------------------------------- */

.adechat-modelpicker {
  display: flex;
  min-height: 0;
  height: 320px;
  width: 460px;
  max-width: 100%;
  border: 1px solid var(--adechat-border);
  border-radius: var(--adechat-radius);
  background: var(--adechat-bg-raised);
  overflow: hidden;
}
.adechat-modelpicker-rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 0 0 auto;
  width: 132px;
  padding: calc(var(--adechat-space) * 0.5);
  border-right: 1px solid var(--adechat-border);
  background: var(--adechat-bg-subtle);
  overflow-y: auto;
}
.adechat-modelpicker-railbutton {
  display: flex;
  align-items: center;
  gap: calc(var(--adechat-space) * 0.75);
  font: inherit;
  font-size: 0.88em;
  text-align: left;
  width: 100%;
  padding: calc(var(--adechat-space) * 0.625) calc(var(--adechat-space) * 0.875);
  border: 0;
  border-radius: var(--adechat-radius-sm);
  background: none;
  color: var(--adechat-muted);
  cursor: pointer;
}
.adechat-modelpicker-railbutton:hover { background: var(--adechat-hover); color: var(--adechat-fg); }
.adechat-modelpicker-railbutton[aria-selected="true"] {
  background: var(--adechat-accent-subtle);
  color: var(--adechat-fg);
}
.adechat-modelpicker-raillabel {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.adechat-status-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.adechat-status-dot[data-status="ok"] { background: var(--adechat-success); }
.adechat-status-dot[data-status="unauthed"] { background: var(--adechat-danger); }
.adechat-status-dot[data-status="missing"] { background: var(--adechat-muted); }

.adechat-modelpicker-main { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.adechat-modelpicker-search {
  font: inherit;
  font-size: 0.9em;
  color: var(--adechat-fg);
  background: none;
  border: 0;
  border-bottom: 1px solid var(--adechat-border);
  outline: none;
  padding: calc(var(--adechat-space) * 1) calc(var(--adechat-space) * 1.25);
}
.adechat-modelpicker-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: calc(var(--adechat-space) * 0.5);
  margin: 0;
  list-style: none;
}
.adechat-modelpicker-group {
  font-size: 0.72em;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--adechat-muted);
  padding: calc(var(--adechat-space) * 0.75) calc(var(--adechat-space) * 0.875) 4px;
}
.adechat-modelpicker-row {
  display: flex;
  align-items: baseline;
  gap: calc(var(--adechat-space) * 0.75);
  width: 100%;
  font: inherit;
  font-size: 0.9em;
  text-align: left;
  padding: calc(var(--adechat-space) * 0.625) calc(var(--adechat-space) * 0.875);
  border: 0;
  border-radius: var(--adechat-radius-sm);
  background: none;
  color: var(--adechat-fg);
  cursor: pointer;
}
.adechat-modelpicker-row:hover:not(:disabled) { background: var(--adechat-hover); }
.adechat-modelpicker-row:disabled { opacity: 0.45; cursor: not-allowed; }
.adechat-modelpicker-row[aria-selected="true"] { background: var(--adechat-accent-subtle); }
.adechat-modelpicker-rowname { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.adechat-modelpicker-rowmeta { flex: 1 1 auto; color: var(--adechat-muted); font-size: 0.85em; text-align: right; }
.adechat-modelpicker-empty { padding: calc(var(--adechat-space) * 2); color: var(--adechat-muted); font-size: 0.9em; }

/* Provider card ---------------------------------------------------------- */

.adechat-providercard {
  display: flex;
  flex-direction: column;
  gap: calc(var(--adechat-space) * 1);
  padding: calc(var(--adechat-space) * 1.5);
  border: 1px solid var(--adechat-border);
  border-radius: var(--adechat-radius);
  background: var(--adechat-bg-subtle);
  color: var(--adechat-fg);
}
.adechat-providercard-head { display: flex; align-items: center; gap: calc(var(--adechat-space) * 0.75); }
.adechat-providercard-name { font-weight: 600; flex: 1 1 auto; }
.adechat-providercard-state { font-size: 0.85em; color: var(--adechat-muted); }
.adechat-providercard-detail { font-size: 0.88em; color: var(--adechat-muted); margin: 0; }
.adechat-providercard-probe {
  display: flex;
  align-items: baseline;
  gap: calc(var(--adechat-space) * 0.75);
  margin: 0;
  font-size: 0.82em;
  color: var(--adechat-muted);
  min-width: 0;
}
.adechat-providercard-probe code {
  font-family: var(--adechat-font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.adechat-command {
  display: flex;
  align-items: center;
  gap: calc(var(--adechat-space) * 0.75);
  padding: calc(var(--adechat-space) * 0.75) calc(var(--adechat-space) * 1);
  border: 1px solid var(--adechat-border);
  border-radius: var(--adechat-radius-sm);
  background: var(--adechat-bg);
}
.adechat-command-text {
  flex: 1 1 auto;
  font-family: var(--adechat-font-mono);
  font-size: 0.85em;
  overflow-x: auto;
  white-space: nowrap;
}

/* Motion ----------------------------------------------------------------- */

@media (prefers-reduced-motion: reduce) {
  .adechat-root *,
  .adechat-root *::before,
  .adechat-root *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
  .adechat-chip-dot[data-status="running"],
  .adechat-activity-dot { animation: none; opacity: 0.7; }
}
`;

/**
 * Insert the stylesheet once per document. Safe to call repeatedly and in SSR
 * (it no-ops without a document).
 */
export function injectAdeChatStyles(target?: Document): void {
  const doc = target ?? (typeof document === "undefined" ? null : document);
  if (!doc) return;
  if (doc.getElementById(ADE_CHAT_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = ADE_CHAT_STYLE_ID;
  style.textContent = adeChatCss;
  doc.head.appendChild(style);
}
