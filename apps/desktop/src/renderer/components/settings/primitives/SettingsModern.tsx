import type { ReactNode } from "react";
import "./settingsModern.css";

/**
 * The modern settings building blocks (see settingsModern.css):
 *
 * - `ModernPage` — the page column: sections 44px apart.
 * - `ModernSection` — heading + one-line hint + optional actions over a block.
 *   It carries `data-settings-group` / `data-settings-anchor` so settings search
 *   and deep links keep working.
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
  actions,
  children,
}: {
  group: string;
  anchor?: string;
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-settings-group={group} data-settings-anchor={anchor} id={anchor} className="ade-ap-section">
      <header className="ade-ap-head">
        <div style={{ minWidth: 0 }}>
          <h2>{title}</h2>
          {hint ? <p>{hint}</p> : null}
        </div>
        {actions ? <div className="ade-ap-actions">{actions}</div> : null}
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
  control,
  children,
}: {
  anchor?: string;
  title: ReactNode;
  hint?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="ade-ap-rowcard" id={anchor} data-settings-anchor={anchor} style={children ? { flexWrap: "wrap" } : undefined}>
      <div style={{ minWidth: 0, flex: "1 1 240px" }}>
        <div className="ade-ap-rowtitle">{title}</div>
        {hint ? <div className="ade-ap-rowhint">{hint}</div> : null}
      </div>
      {control ? <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>{control}</div> : null}
      {children ? <div style={{ flex: "1 0 100%", minWidth: 0 }}>{children}</div> : null}
    </div>
  );
}
