import React from "react";
import type { ContextStatus } from "../../../shared/types";
import { GenerateDocsModal } from "../context/GenerateDocsModal";
import { EmptyState } from "../ui/EmptyState";
import {
  COLORS,
  MONO_FONT,
  LABEL_STYLE,
  cardStyle,
  outlineButton,
  primaryButton,
} from "../lanes/laneDesignTokens";

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 10,
};

function relativeTime(value: string | null | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

export function ContextSection() {
  const [docsStatus, setDocsStatus] = React.useState<ContextStatus | null>(null);
  const [docsModalOpen, setDocsModalOpen] = React.useState(false);
  const [docsLoading, setDocsLoading] = React.useState(false);

  const reloadDocs = React.useCallback(async () => {
    setDocsLoading(true);
    try {
      const status = await window.ade.context.getStatus();
      setDocsStatus(status);
    } catch {
      setDocsStatus(null);
    } finally {
      setDocsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reloadDocs();
  }, [reloadDocs]);

  return (
    <section>
      <div style={sectionLabelStyle}>CONTEXT DOCS</div>
      <div style={{ ...cardStyle({ padding: 16 }), display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary }}>
            Canonical docs remain the stable source for bootstrap and memory ingestion.
          </div>
          <button type="button" style={primaryButton({ height: 28, padding: "0 10px", fontSize: 10 })} onClick={() => setDocsModalOpen(true)}>
            Generate Docs
          </button>
        </div>
        {docsLoading ? (
          <div style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>Loading docs status...</div>
        ) : docsStatus?.docs?.length ? (
          docsStatus.docs.map((doc) => (
            <div key={doc.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, padding: 10 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                <div style={{ fontFamily: MONO_FONT, fontSize: 12, color: COLORS.textPrimary }}>{doc.label}</div>
                <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: doc.exists ? COLORS.success : COLORS.warning }}>
                  {doc.exists ? `present • updated ${relativeTime(doc.updatedAt)}` : "missing"}
                </div>
                <div style={{ fontFamily: MONO_FONT, fontSize: 10, color: COLORS.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {doc.preferredPath}
                </div>
              </div>
              <button
                type="button"
                style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                onClick={() => {
                  void window.ade.context.openDoc({ docId: doc.id }).catch(() => { });
                }}
              >
                Open
              </button>
            </div>
          ))
        ) : (
          <EmptyState title="Docs unavailable" description="Unable to read context doc status." />
        )}
      </div>
      <GenerateDocsModal
        open={docsModalOpen}
        onOpenChange={setDocsModalOpen}
        onCompleted={() => {
          void reloadDocs();
        }}
      />
    </section>
  );
}
