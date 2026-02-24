import React from "react";
import { Warning, CaretDown, CaretRight, Code } from "@phosphor-icons/react";

type ConflictFile = {
  path: string;
  conflictMarkers: string;
  oursExcerpt: string | null;
  theirsExcerpt: string | null;
  diffHunk: string | null;
};

export function ConflictFilePreview({ file }: { file: ConflictFile }) {
  const [showRawMarkers, setShowRawMarkers] = React.useState(false);

  return (
    <div
      style={{
        background: "#0C0A10",
        border: "1px solid #1E1B26",
        marginBottom: 8,
      }}
    >
      {/* File path header */}
      <div
        className="flex items-center justify-between"
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid #1E1B26",
          background: "#13101A",
        }}
      >
        <div className="flex items-center" style={{ gap: 8 }}>
          <Warning size={14} weight="fill" style={{ color: "#F59E0B" }} />
          <span
            className="font-mono font-semibold"
            style={{ fontSize: 11, color: "#FAFAFA" }}
          >
            {file.path}
          </span>
        </div>
        {file.conflictMarkers && (
          <button
            type="button"
            className="flex items-center font-mono font-bold uppercase tracking-[1px] transition-colors duration-100"
            style={{
              fontSize: 9,
              padding: "2px 8px",
              background: showRawMarkers ? "#A78BFA18" : "transparent",
              color: showRawMarkers ? "#A78BFA" : "#52525B",
              border: `1px solid ${showRawMarkers ? "#A78BFA30" : "#27272A"}`,
              cursor: "pointer",
            }}
            onClick={() => setShowRawMarkers(!showRawMarkers)}
          >
            <Code size={10} weight="bold" style={{ marginRight: 4 }} />
            RAW
          </button>
        )}
      </div>

      {/* Ours / Theirs side-by-side excerpts */}
      {(file.oursExcerpt || file.theirsExcerpt) && !showRawMarkers && (
        <div style={{ padding: 12 }}>
          <div className="flex" style={{ gap: 8 }}>
            {/* OURS */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                className="font-mono font-bold uppercase tracking-[1px]"
                style={{
                  fontSize: 9,
                  color: "#22C55E",
                  marginBottom: 6,
                }}
              >
                OURS
              </div>
              <pre
                className="font-mono"
                style={{
                  fontSize: 11,
                  lineHeight: "18px",
                  color: "#A1A1AA",
                  padding: "8px 10px",
                  margin: 0,
                  background: "#22C55E08",
                  borderLeft: "2px solid #22C55E40",
                  overflowX: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {file.oursExcerpt || "(empty)"}
              </pre>
            </div>

            {/* THEIRS */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                className="font-mono font-bold uppercase tracking-[1px]"
                style={{
                  fontSize: 9,
                  color: "#EF4444",
                  marginBottom: 6,
                }}
              >
                THEIRS
              </div>
              <pre
                className="font-mono"
                style={{
                  fontSize: 11,
                  lineHeight: "18px",
                  color: "#A1A1AA",
                  padding: "8px 10px",
                  margin: 0,
                  background: "#EF444408",
                  borderLeft: "2px solid #EF444440",
                  overflowX: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {file.theirsExcerpt || "(empty)"}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Diff hunk preview */}
      {file.diffHunk && !showRawMarkers && (
        <div
          style={{
            padding: "0 12px 12px",
          }}
        >
          <div
            className="font-mono font-bold uppercase tracking-[1px]"
            style={{
              fontSize: 9,
              color: "#71717A",
              marginBottom: 6,
            }}
          >
            DIFF HUNK
          </div>
          <pre
            className="font-mono"
            style={{
              fontSize: 11,
              lineHeight: "18px",
              color: "#A1A1AA",
              padding: "8px 10px",
              margin: 0,
              background: "#0F0D14",
              border: "1px solid #1E1B26",
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {file.diffHunk.split("\n").map((line, i) => {
              let lineColor = "#A1A1AA";
              if (line.startsWith("+")) lineColor = "#22C55E";
              else if (line.startsWith("-")) lineColor = "#EF4444";
              else if (line.startsWith("@@")) lineColor = "#A78BFA";
              return (
                <span key={i} style={{ color: lineColor, display: "block" }}>
                  {line}
                </span>
              );
            })}
          </pre>
        </div>
      )}

      {/* Raw conflict markers (toggle) */}
      {showRawMarkers && file.conflictMarkers && (
        <div style={{ padding: 12 }}>
          <div
            className="font-mono font-bold uppercase tracking-[1px]"
            style={{
              fontSize: 9,
              color: "#F59E0B",
              marginBottom: 6,
            }}
          >
            CONFLICT MARKERS
          </div>
          <pre
            className="font-mono"
            style={{
              fontSize: 11,
              lineHeight: "18px",
              color: "#A1A1AA",
              padding: "8px 10px",
              margin: 0,
              background: "#F59E0B06",
              border: "1px solid #F59E0B15",
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {file.conflictMarkers}
          </pre>
        </div>
      )}

      {/* Fallback: no excerpts, no markers, no hunk */}
      {!file.oursExcerpt && !file.theirsExcerpt && !file.diffHunk && !file.conflictMarkers && (
        <div
          className="font-mono"
          style={{
            fontSize: 11,
            color: "#52525B",
            padding: "10px 12px",
          }}
        >
          No conflict detail available for this file.
        </div>
      )}
    </div>
  );
}
