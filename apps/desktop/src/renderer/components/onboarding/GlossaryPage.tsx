import React, { useMemo, useState } from "react";
import { GLOSSARY } from "../../onboarding/glossary";
import { openExternalUrl } from "../../lib/openExternal";

export function GlossaryPage() {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GLOSSARY;
    return GLOSSARY.filter((t) => {
      return (
        t.term.toLowerCase().includes(q) ||
        t.shortDefinition.toLowerCase().includes(q)
      );
    });
  }, [query]);

  return (
    <div
      className="ade-glossary-page"
      style={{
        padding: "24px 28px",
        maxWidth: 780,
        margin: "0 auto",
        fontFamily: "var(--font-sans)",
        color: "var(--color-fg, #F0F0F2)",
      }}
    >
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 8px" }}>Glossary</h1>
      <p
        style={{
          fontSize: 13,
          color: "var(--color-muted-fg, #908FA0)",
          margin: "0 0 16px",
        }}
      >
        Plain-English definitions for ADE terms. Click any "Read more →" link to
        open the full docs.
      </p>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search terms…"
        aria-label="Search glossary"
        style={{
          width: "100%",
          padding: "8px 10px",
          fontSize: 13,
          background: "rgba(255, 255, 255, 0.04)",
          color: "var(--color-fg, #F0F0F2)",
          border: "1px solid rgba(255, 255, 255, 0.12)",
          borderRadius: 7,
          outline: "none",
          marginBottom: 18,
        }}
      />

      {filtered.length === 0 ? (
        <div
          style={{
            padding: "24px 0",
            color: "var(--color-muted-fg, #908FA0)",
            fontSize: 13,
          }}
        >
          {GLOSSARY.length === 0
            ? "Glossary is empty — terms are coming soon."
            : `No terms match "${query}".`}
        </div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {filtered.map((t) => (
            <li
              key={t.id}
              style={{
                background: "var(--color-popup-bg, #151325)",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                borderRadius: 10,
                padding: "14px 16px",
              }}
            >
              <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>{t.term}</h2>
              <p
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  margin: "0 0 6px",
                  color: "var(--color-muted-fg, #B7B6C3)",
                }}
              >
                {t.shortDefinition}
              </p>
              <p
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  margin: "0 0 8px",
                  color: "var(--color-muted-fg, #908FA0)",
                }}
              >
                {t.longDefinition}
              </p>
              <a
                href={t.docUrl}
                onClick={(e) => {
                  e.preventDefault();
                  openExternalUrl(t.docUrl);
                }}
                className="ade-stt-doc"
              >
                Read more →
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
