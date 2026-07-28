import {
  adeCardDeeplink,
  adeCardFallbackText,
  adeCardProgressTotal,
  isKnownAdeCardVariant,
  normalizeAdeCardTone,
  type AdeCardIcon,
  type AdeCardPayload,
} from "../../../desktop/src/shared/adeCard";

/** Inner content width of an `ade_card` box, in columns (excludes the `│` walls). */
const ADE_CARD_INNER_WIDTH = 46;

const ADE_CARD_ROW_GLYPHS: Record<AdeCardIcon, string> = {
  pass: "✓",
  fail: "✕",
  running: "◐",
  queued: "○",
  skipped: "·",
  info: "·",
  file: "▸",
};

function singleLine(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function padCardCell(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, Math.max(0, width));
  return text + " ".repeat(width - text.length);
}

/** `│ left …gap… right │` at exactly {@link ADE_CARD_INNER_WIDTH}. */
function adeCardBoxRow(left: string, right = ""): string {
  const available = ADE_CARD_INNER_WIDTH - 2;
  const rightText = right.slice(0, Math.max(0, available));
  const leftWidth = Math.max(0, available - rightText.length - (rightText ? 1 : 0));
  const leftText = padCardCell(left, leftWidth);
  return `│ ${leftText}${rightText ? ` ${rightText}` : ""} │`;
}

function adeCardProgressBar(card: AdeCardPayload): string | null {
  const progress = card.progress;
  const total = adeCardProgressTotal(progress);
  if (!progress || total <= 0) return null;
  const width = ADE_CARD_INNER_WIDTH - 2;
  // `▓` carries failure without introducing a terminal-color dependency.
  const cells: Array<[number, string]> = [
    [progress.passed, "█"],
    [progress.failed, "▓"],
    [progress.running, "▒"],
    [progress.queued, "░"],
  ];
  let bar = "";
  for (const [count, glyph] of cells) {
    if (count <= 0) continue;
    bar += glyph.repeat(Math.max(1, Math.round((count / total) * width)));
  }
  return bar.slice(0, width);
}

function formatCardDuration(durationMs: number | null | undefined): string | null {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))}ms`;
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainingSeconds ? ` ${remainingSeconds}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`;
}

/**
 * Box-drawn `ade_card`, the TUI's ambient equivalent of the desktop card:
 * a row in the transcript, not a new pane.
 */
export function renderAdeCardBody(card: AdeCardPayload): string {
  const deeplink = adeCardDeeplink(card.navTarget);
  if (!isKnownAdeCardVariant(card.variant)) {
    const fallback = singleLine(adeCardFallbackText(card), 160);
    return deeplink && !fallback.includes(deeplink) ? `${fallback}\n${deeplink}` : fallback;
  }

  const failing = (card.progress?.failed ?? 0) > 0
    || (card.rows ?? []).some((row) => normalizeAdeCardTone(row.tone) === "warning")
    || (card.metrics ?? []).some((metric) => normalizeAdeCardTone(metric.tone) === "warning");
  const degradedReason = card.degradedReason?.trim() || null;
  const glyph = card.state === "live" ? "◐" : failing ? "✕" : degradedReason ? "!" : "✓";
  const heading = singleLine(
    [card.title, card.subtitle?.trim() || null].filter(Boolean).join(" · "),
    ADE_CARD_INNER_WIDTH - 6,
  );

  const lines: string[] = [];
  const headText = `─ ${glyph} ${heading} `.slice(0, ADE_CARD_INNER_WIDTH);
  lines.push(`┌${headText}${"─".repeat(ADE_CARD_INNER_WIDTH - headText.length)}┐`);

  const bar = adeCardProgressBar(card);
  if (bar) lines.push(adeCardBoxRow(bar));

  const metrics = (card.metrics ?? []).map((metric) => `${metric.value} ${metric.label}`.trim());
  if (metrics.length) lines.push(adeCardBoxRow(metrics.join("  ")));

  const duration = formatCardDuration(card.durationMs);
  const statusMeta = [
    card.stale ? "stale" : null,
    duration ? `ran ${duration}` : null,
  ].filter((value): value is string => Boolean(value));
  if (degradedReason) {
    lines.push(adeCardBoxRow("! detail unavailable", statusMeta.join(" · ")));
    lines.push(adeCardBoxRow(singleLine(degradedReason, ADE_CARD_INNER_WIDTH - 2)));
  } else if (statusMeta.length) {
    lines.push(adeCardBoxRow(statusMeta.join(" · ")));
  }

  const rows = (card.rows ?? []).slice(0, 5);
  if (rows.length) {
    lines.push(adeCardBoxRow(""));
    for (const row of rows) {
      const rowGlyph = row.icon ? ADE_CARD_ROW_GLYPHS[row.icon] ?? "·" : "·";
      lines.push(adeCardBoxRow(`${rowGlyph} ${row.text}`, row.detail?.trim() ?? ""));
    }
    if ((card.rowsTruncated ?? 0) > 0) {
      lines.push(adeCardBoxRow(`+${card.rowsTruncated} more`));
    }
  }

  if (deeplink) {
    lines.push(adeCardBoxRow(""));
    lines.push(adeCardBoxRow("[o] open"));
  }

  lines.push(`└${"─".repeat(ADE_CARD_INNER_WIDTH)}┘`);
  if (deeplink) lines.push(deeplink);
  return lines.join("\n");
}
