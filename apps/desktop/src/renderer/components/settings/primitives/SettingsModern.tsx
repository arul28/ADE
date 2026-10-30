import type { ReactNode } from "react";
import { SettingsRowIcon, type SettingsTone } from "./SettingsRows";
import "./settingsModern.css";

/**
 * The modern settings building blocks (see settingsModern.css):
 *
 * - `ModernPage` — the page column: sections 44px apart.
 * - `ModernSection` — heading + one-line hint + optional actions over a block.
 *   It carries `data-settings-group` / `data-settings-anchor` so settings search
 *   and deep links keep working. `size="step"` is a step inside a page whose
 *   tab is already the heading (Lanes → New lanes): a smaller h3, tighter gap.
 * - `ModernRows` + `ModernRow` — a grouped panel of rows: title and hint on the
 *   left, the control on the right, optional extra content under the row.
 * - Choice cards use the `.ade-ap-grid3` / `.ade-ap-choice` classes directly.
 */

export function ModernPage({ children }: { children: ReactNode }) {
  return <div className="ade-modern-page">{children}</div>;
}

export function ModernSection({
  group,
  anchor,
  title,
  hint,
  icon,
  tone = "accent",
  size = "section",
  actions,
  children,
}: {
  group: string;
  anchor?: string;
  title: string;
  hint?: ReactNode;
  /** A tinted glyph before the heading, so a long page scans by shape. */
  icon?: ReactNode;
  tone?: SettingsTone | string;
  size?: "section" | "step";
  actions?: ReactNode;
  children: ReactNode;
}) {
  const step = size === "step";
  return (
    <section
      data-settings-group={group}
      data-settings-anchor={anchor}
      id={anchor}
      className={step ? "ade-modern-step" : "ade-ap-section"}
    >
      <header className={step ? "ade-modern-step-head" : "ade-ap-head"}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, minWidth: 0 }}>
          {icon ? <SettingsRowIcon icon={icon} tone={tone} /> : null}
          <div style={{ minWidth: 0 }}>
            {step ? <h3>{title}</h3> : <h2>{title}</h2>}
            {hint ? <p>{hint}</p> : null}
          </div>
        </div>
        {actions ? <div className={step ? "ade-modern-step-actions" : "ade-ap-actions"}>{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function ModernRows({ children }: { children: ReactNode }) {
  return <div className="ade-modern-rows">{children}</div>;
}

export function ModernRow({
  anchor,
  title,
  hint,
  icon,
  leading,
  tone = "accent",
  control,
  children,
}: {
  anchor?: string;
  title: ReactNode;
  hint?: ReactNode;
  /** A small tinted glyph before the title; omit on a section's only row when the section already carries one. */
  icon?: ReactNode;
  /** A tile that is already its own picture (a machine's avatar), drawn as is in place of `icon`. */
  leading?: ReactNode;
  tone?: SettingsTone | string;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="ade-ap-rowcard" id={anchor} data-settings-anchor={anchor} style={children ? { flexWrap: "wrap" } : undefined}>
      <div style={{ minWidth: 0, flex: "1 1 240px", display: "flex", alignItems: leading ? "center" : "flex-start", gap: 10 }}>
        {leading ?? (icon ? <SettingsRowIcon icon={icon} tone={tone} /> : null)}
        <div style={{ minWidth: 0 }}>
          <div className="ade-ap-rowtitle">{title}</div>
          {hint ? <div className="ade-ap-rowhint">{hint}</div> : null}
        </div>
      </div>
      {control ? <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>{control}</div> : null}
      {children ? <div style={{ flex: "1 0 100%", minWidth: 0 }}>{children}</div> : null}
    </div>
  );
}
