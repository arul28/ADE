/**
 * `ade cloud status --text`: whether a new lane can start, the plan, credits,
 * computers, agents, each lane and the sizes (Pricing v2: unlimited Small
 * computers, computers per plan, credits as time on each size, no plan disk).
 *
 * Split from `cli.ts`, which keeps the formatter switch. The import cycle rule
 * of `cliMacDesktopFormat.ts` applies to `./cli`:
 *
 *   NEITHER FILE MAY USE THE OTHER'S IMPORTS AS A VALUE AT MODULE SCOPE.
 */
import { formatCloudHoursRate } from "../../desktop/src/shared/adeCloud";
import { CLOUD_CREDIT_WORDS, cloudUnitWords, type CloudUnitWords } from "../../desktop/src/shared/cloudUnitWords";
import { isRecord } from "./cli";

/** "12.5" from a number of hours, "—" when unknown. */
/** Hours to the tenth, rounded down, as the desktop writes them: 299.8 left reads "299.8", never "300". */
function cloudHoursText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? (Math.floor(Math.max(0, value) * 10 + 1e-9) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 })
    : "—";
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

/** "uses no credits" (Small), "uses 2.5 credits an hour": a rate in words, never a multiplier; "—" when unknown. */
function cloudRateText(value: unknown, words: CloudUnitWords = CLOUD_CREDIT_WORDS): string {
  return typeof value === "number" && Number.isFinite(value) ? formatCloudHoursRate(value, words) : "—";
}

/** The words of `cloud.status`, at the iPhone's rate it sends (`credits.iphonePerMinute`). */
function statusWords(status: Record<string, unknown>): CloudUnitWords {
  const credits = isRecord(status.credits) ? status.credits : null;
  const perMinute = credits && typeof credits.iphonePerMinute === "number" ? credits.iphonePerMinute : null;
  return cloudUnitWords(perMinute != null ? { credits: { phoneMilliPerMinute: perMinute * 1000 } } : null);
}

/** "$5", "$1.50": cents as dollars, cents shown only when there are some. */
function dollarsText(cents: unknown): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

/** The iPhone row: its rate from the credits and what it used this period. */
function cloudIphoneText(iphone: Record<string, unknown>, words: CloudUnitWords): string {
  const used = typeof iphone.creditsUsed === "number" ? ` · ${cloudHoursText(iphone.creditsUsed)} credits used this period` : "";
  return `uses ${words.count(words.phoneMilliPerMinute / 1000)} a minute from your credits${used}`;
}

/**
 * `ade cloud status --text`: whether a new lane can start (the reason first
 * when it can't), then the plan, credits, computers, agents, each lane
 * and the sizes, in aligned rows.
 */
export function formatCloudStatus(value: unknown): string {
  const raw = isRecord(value) && isRecord(value.result) ? value.result : value;
  const status = isRecord(raw) ? raw : {};
  const words = statusWords(status);
  const rows: Array<[string, string]> = [];
  const can = isRecord(status.canStartLane) ? status.canStartLane : {};
  const lines: string[] = [];
  if (can.ok === true) rows.push(["New lane", "can start now"]);
  else lines.push(`No new lane on ADE Cloud now: ${typeof can.reason === "string" ? can.reason : "ADE couldn't tell why."}`);
  const plan = isRecord(status.plan) ? status.plan : null;
  const hours = isRecord(status.hours) ? status.hours : null;
  if (plan) {
    const includes = isRecord(plan.includes) ? plan.includes : {};
    const computers = typeof includes.computers === "number" ? `${includes.computers} cloud ${includes.computers === 1 ? "computer" : "computers"}` : null;
    // A period keeps the credits it began with: when the plan's credits changed
    // since (a new plan table), say both, so this line and Credits agree.
    const periodHours = hours && typeof hours.included === "number" ? hours.included : null;
    const resetsOn = hours && typeof hours.resetsAt === "string" ? hours.resetsAt.slice(0, 10) : null;
    const planHours = typeof includes.hours === "number"
      ? periodHours != null && periodHours !== includes.hours && resetsOn
        ? `${cloudHoursText(periodHours)} credits this period, ${cloudHoursText(includes.hours)} from ${resetsOn}`
        : `${cloudHoursText(includes.hours)} credits`
      : null;
    const facts = [
      computers,
      "unlimited Small computers",
      planHours,
      includes.outsideAgents === false ? "no outside agents" : null,
    ].filter(Boolean).join(", ");
    const pastDue = plan.pastDue === true ? " · last payment failed, free plan rules until paid" : "";
    rows.push(["Plan", `${String(plan.label ?? plan.id ?? "—")}${facts ? ` (${facts})` : ""}${pastDue}`]);
  }
  if (hours) {
    const resets = typeof hours.resetsAt === "string" ? hours.resetsAt.slice(0, 10) : "—";
    const extra = isRecord(hours.extraHours) && hours.extraHours.enabled === true ? ` · ${words.extra.toLowerCase()} on` : "";
    const out = hours.state === "zero" ? " · out: bigger computers and the iPhone stop, Small keeps working" : "";
    rows.push([words.Noun, `${cloudHoursText(hours.left)} of ${cloudHoursText(hours.included)} left · resets ${resets}${extra}${out}`]);
  }
  if (typeof status.smallComputers === "string") rows.push(["Small", status.smallComputers]);
  // Only an account that has the ADE Cloud iPhone gets this part.
  const iphone = isRecord(status.iphone) && status.iphone.access === "on" ? status.iphone : null;
  if (iphone) rows.push(["iPhone", cloudIphoneText(iphone, words)]);
  const computers = isRecord(status.computers) ? status.computers : null;
  // Cloud computers asleep or not, of the plan's limit (an older ADE sends no limit: a count only).
  if (computers) {
    const of = typeof computers.limit === "number" ? ` of ${computers.limit}` : "";
    rows.push(["Computers", `${String(computers.inUse ?? "—")}${of} cloud ${computers.inUse === 1 && !of ? "computer" : "computers"} (asleep or not) · ${String(computers.awake ?? 0)} awake`]);
  }
  rows.push(["Default size", typeof status.defaultSize === "string" ? status.defaultSize : "unknown here (the app's choice)"]);
  const agents = isRecord(status.agents) ? status.agents : null;
  if (agents) {
    const sizes = Array.isArray(agents.sizesAllowed) ? agents.sizesAllowed.join(", ") : "—";
    rows.push(["Agents", agents.unattendedSpend === true
      ? `${String(agents.newComputersLeftToday ?? 0)} of ${String(agents.newComputersPerDay ?? 0)} new computers left today · alone up to: ${sizes}`
      : `agents nobody watches may not use ${words.noun}; attended agents ask in their chat`]);
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
    // A computer that never signed in to ADE (its join failed or is waiting
    // for approval) runs no ADE yet: neither "running" nor "up to date" is true.
    const notJoined = "machineKey" in box && !box.machineKey;
    return [
      lane ? boxName(box) : `(no lane) ${boxName(box)}`,
      size,
      cloudRateText(box.hoursRate, words),
      notJoined ? `${String(box.state ?? "")}, not joined to ADE yet` : String(box.state ?? ""),
      lane && typeof lane.projectOrigin === "string" ? lane.projectOrigin : "",
      notJoined ? "" : cloudUpdateText(box.update),
      typeof box.deletesAt === "string" ? `computer deleted ${box.deletesAt.slice(0, 10)} unless used or kept` : "",
    ];
  });
  const sizes = Array.isArray(status.sizes) ? status.sizes.filter(isRecord) : [];
  const sizeRows = sizes.map((size) => [
    String(size.id ?? ""),
    `${size.kind === "full" ? "full computer" : "standard"} · ${String(size.cpu ?? "?")} CPU · ${String(size.memoryGb ?? "?")} GB`,
    size.usesHours === false || size.hoursRate === 0 ? `unlimited (never uses ${words.noun})` : cloudRateText(size.hoursRate, words),
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
  // Lanes whose computer was deleted: the lane and its chats stay; the next message makes a new computer.
  const gone = Array.isArray(status.lanesComputerDeleted) ? status.lanesComputerDeleted.filter(isRecord) : [];
  // Null: ADE couldn't read them, which is not "none" (an older ADE sends no field at all).
  if (status.lanesComputerDeleted === null) lines.push("", "Lanes whose computer was deleted: ADE couldn't read them just now. ade cloud lanes --deleted tries again.");
  if (gone.length) {
    lines.push("", "Lanes whose computer was deleted (their next message makes a new one; ade cloud lanes)", ...table(gone.map((lane) => [
      String(lane.name ?? lane.laneId ?? "lane"),
      typeof lane.projectOrigin === "string" ? lane.projectOrigin : "",
      typeof lane.why === "string" ? lane.why : "",
    ])));
  }
  if (status.lanesComputerDeletedPartial === true) lines.push("  (Read from your newest saved chats only: a lane known only from older chats may be missing.)");
  if (sizeRows.length) lines.push("", "Sizes (ade chat create --machine cloud --size <id>)", ...table(sizeRows));
  const plans = Array.isArray(status.plans) ? status.plans.filter(isRecord) : [];
  if (plans.length) {
    lines.push("", `Plans (a month; Small computers are unlimited on every plan; past the plan's ${words.noun})`, ...table(plans.map((plan) => [
      `${String(plan.label ?? plan.id)}${plan.current === true ? " (yours)" : ""}`,
      typeof plan.priceUsdMonth === "number" ? `${dollarsText(plan.priceUsdMonth * 100)}` : "?",
      typeof plan.computers === "number" ? `${plan.computers} computers` : "",
      `${cloudHoursText(plan.hours)} credits${typeof plan.hoursOnSizes === "string" && plan.hoursOnSizes ? ` (${plan.hoursOnSizes})` : ""}`,
      `${words.extra.toLowerCase()}: ${typeof plan.extraHourCents === "number" ? `${plan.extraHourCents}¢ each` : "none"}`,
      plan.outsideAgents === false ? "no outside agents" : "outside agents ok",
    ])));
    if (typeof hours?.unit === "string") lines.push(`  ${hours.unit}`);
  }
  return lines.join("\n");
}
