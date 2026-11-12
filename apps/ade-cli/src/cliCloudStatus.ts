/**
 * `ade cloud status --text`: whether a new lane can start, the plan, hours,
 * disk, computers, agents, each lane and the sizes.
 *
 * Split from `cli.ts`, which keeps the formatter switch. The import cycle rule
 * of `cliMacDesktopFormat.ts` applies to `./cli`:
 *
 *   NEITHER FILE MAY USE THE OTHER'S IMPORTS AS A VALUE AT MODULE SCOPE.
 */
import { isRecord } from "./cli";

/** "12.5" from a number of hours, "—" when unknown. */
function cloudHoursText(value: unknown): string {
  return typeof value === "number" ? String(Math.round(value * 10) / 10) : "—";
}

/**
 * A computer's image and how it keeps current, for `ade cloud status --text`:
 * "ade@12 beta, up to date", "ade@12 beta, ade@13 next" (it updates itself when idle),
 * "ade@12 beta, updating to ade@13", "ade@12 beta, update failed: why".
 */
function cloudUpdateText(value: unknown): string {
  if (!isRecord(value)) return "";
  const image = typeof value.image === "string" ? value.image : "image unknown";
  const target = typeof value.target === "string" ? value.target : null;
  const head = `${image} ${value.channel === "beta" ? "beta" : "stable"}`;
  if (value.state === "updating") return `${head}, updating${target && target !== image ? ` to ${target}` : ""}`;
  if (value.state === "failed") return `${head}, update failed${typeof value.error === "string" ? `: ${value.error.replace(/\.$/, "")}` : ""}`;
  return target && target !== image ? `${head}, ${target} next` : `${head}, up to date`;
}

/**
 * `ade cloud status --text`: whether a new lane can start (the reason first
 * when it can't), then the plan, hours, disk, computers, agents, each lane
 * and the sizes, in aligned rows.
 */
export function formatCloudStatus(value: unknown): string {
  const raw = isRecord(value) && isRecord(value.result) ? value.result : value;
  const status = isRecord(raw) ? raw : {};
  const rows: Array<[string, string]> = [];
  const can = isRecord(status.canStartLane) ? status.canStartLane : {};
  const lines: string[] = [];
  if (can.ok === true) rows.push(["New lane", "can start now"]);
  else lines.push(`No new lane on ADE Cloud now: ${typeof can.reason === "string" ? can.reason : "ADE couldn't tell why."}`);
  const plan = isRecord(status.plan) ? status.plan : null;
  if (plan) {
    const includes = isRecord(plan.includes) ? plan.includes : {};
    // The plan's disk is one total shared by all the account's computers (every server since plans).
    const disk = typeof includes.diskGb === "number" ? `${includes.diskGb} GB disk shared by all computers` : null;
    const facts = [
      typeof includes.hours === "number" ? `${cloudHoursText(includes.hours)} hours` : null,
      typeof includes.computers === "number" ? `${includes.computers} computers at once` : null,
      disk,
    ].filter(Boolean).join(", ");
    const pastDue = plan.pastDue === true ? " · last payment failed, free plan rules until paid" : "";
    rows.push(["Plan", `${String(plan.label ?? plan.id ?? "—")}${facts ? ` (${facts})` : ""}${pastDue}`]);
  }
  const hours = isRecord(status.hours) ? status.hours : null;
  if (hours) {
    const resets = typeof hours.resetsAt === "string" ? hours.resetsAt.slice(0, 10) : "—";
    const extra = isRecord(hours.extraHours) && hours.extraHours.enabled === true ? " · extra hours on" : "";
    rows.push(["Hours", `${cloudHoursText(hours.left)} of ${cloudHoursText(hours.included)} left · resets ${resets}${extra}`]);
  }
  const disk = isRecord(status.disk) ? status.disk : null;
  if (disk) rows.push(["Disk", `${cloudHoursText(disk.usedGb)}${typeof disk.limitGb === "number" ? ` of ${disk.limitGb}` : ""} GB used`]);
  const computers = isRecord(status.computers) ? status.computers : null;
  if (computers) rows.push(["Computers", `${String(computers.inUse ?? "—")} of ${String(computers.max ?? "—")} in use · ${String(computers.awake ?? 0)} awake`]);
  rows.push(["Default size", typeof status.defaultSize === "string" ? status.defaultSize : "unknown here (the app's choice)"]);
  const agents = isRecord(status.agents) ? status.agents : null;
  if (agents) {
    const sizes = Array.isArray(agents.sizesAllowed) ? agents.sizesAllowed.join(", ") : "—";
    rows.push(["Agents", agents.unattendedSpend === true
      ? `${String(agents.newComputersLeftToday ?? 0)} of ${String(agents.newComputersPerDay ?? 0)} new computers left today · alone up to: ${sizes}`
      : "agents nobody watches may not use hours; attended agents ask in their chat"]);
  }
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, text] of rows) lines.push(`${label.padEnd(width)}  ${text}`);
  const lanes = Array.isArray(status.lanes) ? status.lanes.filter(isRecord) : [];
  lines.push("", lanes.length ? "Lanes" : "No computers on ADE Cloud yet.");
  /** A computer's name in this listing: its lane's, else its own. */
  const boxName = (box: Record<string, unknown>): string => {
    const lane = isRecord(box.lane) ? box.lane : null;
    const laneName = lane && typeof lane.name === "string" ? lane.name : "";
    return laneName || String(box.name ?? box.instanceId ?? "computer");
  };
  const laneRows = lanes.map((box) => {
    const lane = isRecord(box.lane) ? box.lane : null;
    const size = isRecord(box.size) ? String(box.size.label ?? "") : String(box.sizeLabel ?? "");
    return [
      lane ? boxName(box) : `(no lane) ${boxName(box)}`,
      size,
      typeof box.hoursRate === "number" ? `${box.hoursRate}× hours` : "—",
      String(box.state ?? ""),
      lane && typeof lane.projectOrigin === "string" ? lane.projectOrigin : "",
      cloudUpdateText(box.update),
      typeof box.deletesAt === "string" ? `deleted ${box.deletesAt.slice(0, 10)} unless used` : "",
    ];
  });
  const sizes = Array.isArray(status.sizes) ? status.sizes.filter(isRecord) : [];
  const sizeRows = sizes.map((size) => [
    String(size.id ?? ""),
    `${size.kind === "full" ? "full computer" : "standard"} · ${String(size.cpu ?? "?")} CPU · ${String(size.memoryGb ?? "?")} GB`,
    typeof size.hoursRate === "number" ? `${size.hoursRate}× hours` : "—",
    size.isDefault === true ? "default" : "",
  ]);
  const table = (cells: string[][]): string[] => {
    const widths = cells[0]?.map((_, column) => Math.max(...cells.map((row) => row[column]!.length))) ?? [];
    return cells.map((row) => `  ${row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()}`);
  };
  lines.push(...table(laneRows));
  // A computer whose disk is full and can't grow: the reason and the way out
  // (`cloudDiskFullMessage`), so an agent can explain why its turns stop.
  for (const box of lanes) {
    const boxDisk = isRecord(box.disk) ? box.disk : null;
    if (typeof boxDisk?.full !== "string" || !boxDisk.full.trim()) continue;
    const size = typeof boxDisk.sizeGb === "number" ? ` (${boxDisk.sizeGb} GB disk)` : "";
    lines.push(`  ${boxName(box)}${size}: ${boxDisk.full.trim()}`);
  }
  if (sizeRows.length) lines.push("", "Sizes (ade chat create --machine cloud --size <id>)", ...table(sizeRows));
  return lines.join("\n");
}
