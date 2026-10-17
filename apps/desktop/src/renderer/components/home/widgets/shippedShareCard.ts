/**
 * Draws the "Shipped this week" share card: a 1200×675 PNG in ADE's look
 * (deep gradient, mono eyebrows, one accent per figure), from the same
 * numbers the widget shows. Canvas 2D only: no DOM capture, no extra
 * dependency, nothing leaves the machine.
 */

export type ShippedShareData = {
  weekLabel: string;
  merged: number;
  commits: number | null;
  chats: number | null;
  insertions: number | null;
  deletions: number | null;
  /** Merges per weekday, Monday first. */
  perDay: number[];
  topRepos: Array<{ name: string; merged: number }>;
  userName: string | null;
};

const WIDTH = 1200;
const HEIGHT = 675;

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function drawShippedShareCard(data: ShippedShareData): Promise<string> {
  // Wait for the app's fonts so the canvas uses them, not a fallback.
  await document.fonts?.ready.catch(() => undefined);
  const style = getComputedStyle(document.documentElement);
  const sans = style.getPropertyValue("--font-sans").trim() || "Inter, system-ui, sans-serif";
  const mono = style.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace";
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH * scale;
  canvas.height = HEIGHT * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable.");
  ctx.scale(scale, scale);

  // Backdrop: night-violet gradient with two soft lights.
  const base = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  base.addColorStop(0, "#120f24");
  base.addColorStop(0.55, "#1a1534");
  base.addColorStop(1, "#0d1a2e");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const glow = (x: number, y: number, r: number, color: string) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  };
  glow(180, 40, 520, "rgba(163,113,247,0.32)");
  glow(1080, 640, 560, "rgba(56,139,253,0.22)");

  // Card.
  const pad = 56;
  roundRect(ctx, pad, pad, WIDTH - pad * 2, HEIGHT - pad * 2, 28);
  ctx.fillStyle = "rgba(255,255,255,0.045)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const left = pad + 48;
  let y = pad + 60;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = `600 15px ${mono}`;
  const eyebrow = `SHIPPED THIS WEEK · ${data.weekLabel.toUpperCase()}`;
  let x = left;
  for (const char of eyebrow) {
    ctx.fillText(char, x, y);
    x += ctx.measureText(char).width + 2.2;
  }
  y += 52;
  ctx.fillStyle = "#ffffff";
  ctx.font = `650 44px ${sans}`;
  const headline = data.merged > 0
    ? `${data.merged} pull request${data.merged === 1 ? "" : "s"} merged`
    : "A week of building";
  ctx.fillText(headline, left, y);
  if (data.userName) {
    y += 34;
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = `400 20px ${sans}`;
    ctx.fillText(`by ${data.userName}`, left, y);
  }

  // Stat tiles, across the card.
  const contentWidth = WIDTH - 2 * left;
  const linesZero = (data.insertions ?? 0) === 0 && (data.deletions ?? 0) === 0;
  const stats: Array<{ label: string; value: string; color: string }> = [
    { label: "PRs merged", value: String(data.merged), color: "#c09bff" },
    { label: "Commits", value: data.commits == null ? "—" : compact(data.commits), color: "#ffffff" },
    { label: "Chats", value: data.chats == null ? "—" : compact(data.chats), color: "#ffffff" },
    { label: "Lines", value: data.insertions == null ? "—" : linesZero ? "0" : `+${compact(data.insertions)}`, color: linesZero ? "#ffffff" : "#56d364" },
  ];
  const tileTop = pad + 186;
  const tileGap = 16;
  const tileW = (contentWidth - tileGap * 3) / 4;
  const tileH = 108;
  stats.forEach((stat, index) => {
    const tx = left + index * (tileW + tileGap);
    roundRect(ctx, tx, tileTop, tileW, tileH, 16);
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fill();
    ctx.fillStyle = stat.color;
    ctx.font = `600 46px ${sans}`;
    ctx.fillText(stat.value, tx + 22, tileTop + 60);
    if (stat.label === "Lines" && data.deletions != null && !linesZero) {
      const w = ctx.measureText(stat.value).width;
      ctx.fillStyle = "#ff7b72";
      ctx.font = `600 22px ${sans}`;
      ctx.fillText(`−${compact(data.deletions)}`, tx + 30 + w, tileTop + 60);
    }
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = `500 13px ${mono}`;
    ctx.fillText(stat.label.toUpperCase(), tx + 22, tileTop + 88);
  });

  // Merges per day: a full-width strip under the tiles.
  const chartTop = tileTop + tileH + 44;
  const chartBottom = chartTop + 118;
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = `600 13px ${mono}`;
  ctx.fillText("MERGES PER DAY", left, chartTop - 14);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const max = Math.max(1, ...data.perDay);
  const repoColumn = 300;
  const chartRight = left + contentWidth - repoColumn - 32;
  const slot = (chartRight - left) / 7;
  data.perDay.forEach((count, index) => {
    const barW = slot * 0.62;
    const bx = left + index * slot + (slot - barW) / 2;
    const track = chartBottom - chartTop - 22;
    roundRect(ctx, bx, chartTop, barW, track, 8);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fill();
    if (count > 0) {
      const h = Math.max(14, (track * count) / max);
      const gradient = ctx.createLinearGradient(0, chartTop + track - h, 0, chartTop + track);
      gradient.addColorStop(0, "#c09bff");
      gradient.addColorStop(1, "#8957e5");
      roundRect(ctx, bx, chartTop + track - h, barW, h, 8);
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = `600 15px ${sans}`;
      ctx.textAlign = "center";
      ctx.fillText(String(count), bx + barW / 2, chartTop + track - h - 8);
    }
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = `500 12px ${mono}`;
    ctx.textAlign = "center";
    ctx.fillText(days[index]!.toUpperCase(), bx + barW / 2, chartBottom);
    ctx.textAlign = "left";
  });

  // Top repos, in the column beside the chart.
  const repoLeft = left + contentWidth - repoColumn;
  let ry = chartTop - 14;
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = `600 13px ${mono}`;
  ctx.fillText("TOP REPOS", repoLeft, ry);
  ry += 12;
  for (const repo of data.topRepos.slice(0, 3)) {
    roundRect(ctx, repoLeft, ry, repoColumn, 34, 17);
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `500 17px ${sans}`;
    let label = repo.name;
    while (ctx.measureText(label).width > repoColumn - 80 && label.length > 4) label = `${label.slice(0, -2)}…`;
    ctx.fillText(label, repoLeft + 16, ry + 23);
    ctx.fillStyle = "#c09bff";
    ctx.font = `600 15px ${mono}`;
    ctx.textAlign = "right";
    ctx.fillText(String(repo.merged), repoLeft + repoColumn - 16, ry + 23);
    ctx.textAlign = "left";
    ry += 42;
  }
  if (data.topRepos.length === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = `400 17px ${sans}`;
    ctx.fillText("No merges yet this week.", repoLeft, ry + 22);
  }

  // Footer mark.
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = `800 22px ${sans}`;
  ctx.textAlign = "right";
  ctx.fillText("ADE", WIDTH - pad - 48, HEIGHT - pad - 34);
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = `400 14px ${sans}`;
  ctx.fillText("Made in ADE", WIDTH - pad - 48, HEIGHT - pad - 14);
  ctx.textAlign = "left";

  return canvas.toDataURL("image/png");
}
