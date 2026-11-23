#!/usr/bin/env node
// The ADE Cloud account test tool and instant switches, from a terminal.
// Guide: docs/features/ade-cloud/account-test-tool.md. Routes:
// apps/account-directory/src/cloud/ownerAccounts.ts.
//
// Needs CLOUD_OWNER_TOKEN in the environment. Agents run it through ADE's
// secrets so the token is never printed:
//   ade secrets exec --env CLOUD_OWNER_TOKEN -- node scripts/cloud-owner.mjs show you@example.com
//
// Every change takes effect on the account's next read. No deploy.

const USAGE = `Usage: node scripts/cloud-owner.mjs <command> [args]

Accounts (an email, or a Clerk user id that starts with user_):
  show <account>                         the real plan, the test, what is in force, the change log
  act-as <account> <free|plus|pro|max>   the account acts as that plan (limits, hours, cards); Stripe untouched
  limits <account> [--computers N] [--hours N] [--phone-minutes N]
                                         its own computer limit, monthly hours and iPhone minutes
                                         this period (none: clear them; no option: clear all three)
  phone <account> <nomac|revyl|both|off> on the ADE Cloud iPhone's beta list with that provider
                                         (both: the default provider first, then the other), or off it; not a test
  tester <account> <on|off>              on the sponsored testers list (ads switch "testers")
  reset <account>                        back to the real plan: every test field cleared

  Options for act-as and limits: --days N (how long the test lasts, default 7, at most 90),
  --note "why" (kept in the change log).

Switches:
  settings                               every switch, its deploy ceiling and what is in force
  set <key> <value> [--note "why"]       gravity_ads off|testers|all, gravity_live off|on,
                                         free_small_needs_ads off|on

Environment: CLOUD_OWNER_TOKEN (required), ADE_ACCOUNT_ORIGIN (default https://account.ade-app.dev).`;

const origin = (process.env.ADE_ACCOUNT_ORIGIN || "https://account.ade-app.dev").replace(/\/+$/, "");
// The owner token goes only over HTTPS, or plain HTTP to this machine (a local Worker).
{
  let url;
  try {
    url = new URL(origin);
  } catch {
    console.error(`ADE_ACCOUNT_ORIGIN is not a URL: ${origin}`);
    process.exit(1);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    console.error("ADE_ACCOUNT_ORIGIN must be https://, or http:// to localhost, so the owner token is never sent in the clear.");
    process.exit(1);
  }
}
const token = process.env.CLOUD_OWNER_TOKEN?.trim();

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** The options each command takes; any other is refused before a request goes. */
const COMMAND_OPTIONS = {
  "act-as": ["days", "note"],
  limits: ["computers", "hours", "phone-minutes", "days", "note"],
  set: ["note"],
};

function readOptions(command, args) {
  const allowed = COMMAND_OPTIONS[command] ?? [];
  const options = {};
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    if (!allowed.includes(arg.slice(2))) fail(`${command ?? "This command"} takes no ${arg}.\n\n${USAGE}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${arg} needs a value.\n\n${USAGE}`);
    options[arg.slice(2)] = value;
    index += 1;
  }
  return { options, rest };
}

function whole(name, value) {
  if (value === undefined) return undefined;
  if (value === "none" || value === "null") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) fail(`--${name} is a whole number, or none.`);
  return number;
}

const accountRef = (value) => {
  if (!value) fail(`Name an account.\n\n${USAGE}`);
  return value.includes("@") ? { email: value } : { userId: value };
};

async function call(path, body) {
  if (!token) fail("CLOUD_OWNER_TOKEN is not set. Run it as: ade secrets exec --env CLOUD_OWNER_TOKEN -- node scripts/cloud-owner.mjs …");
  const response = await fetch(`${origin}/cloud/owner/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!response.ok) fail(`${response.status}: ${typeof parsed === "object" ? parsed?.error?.message ?? text : text}`);
  return parsed;
}

const when = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never");

function printAccount({ account }) {
  const lines = [
    `${account.email ?? account.userId} (${account.userId})`,
    `  Real plan:  ${account.real.plan} · ${account.real.computers} computers · ${account.real.hours} hours this period · Stripe ${account.real.stripeStatus ?? "none"}`,
    account.test
      ? `  Test:       ${[account.test.plan && `acts as ${account.test.plan}`, account.test.computers != null && `${account.test.computers} computers`, account.test.hours != null && `${account.test.hours} hours`, account.test.phoneMinutes != null && `${account.test.phoneMinutes} iPhone minutes`].filter(Boolean).join(" · ")} · ends ${when(account.test.until)}${account.test.note ? ` · "${account.test.note}"` : ""}`
      : "  Test:       none",
    `  iPhone:     ${account.phone.access}${account.phone.listed ? ` · beta list: ${account.phone.listed}` : " · not on the beta list"} · ${account.phone.usedMinutes} of ${account.phone.minutes} minutes used${account.phone.minutes !== account.phone.planMinutes ? ` (plan: ${account.phone.planMinutes})` : ""}${account.phone.extraOn ? " · extra minutes on" : ""}`,
    `  In force:   ${account.inForce.plan} · ${account.inForce.computers} computers · ${account.inForce.hours} hours (${account.inForce.usedHours} used) · Small ${account.inForce.smallUsesHours ? "uses hours" : "unlimited"}`,
    `  Sponsored:  switch ${account.sponsored.mode} · ${account.sponsored.tester ? "on the testers list" : "not a tester"} · answer ${account.sponsored.consent ?? "never asked"}`,
  ];
  if (account.log.length) {
    lines.push("  Changes:");
    for (const row of account.log) lines.push(`    ${when(row.at)}  ${row.action}  ${JSON.stringify(row.detail)}`);
  }
  console.log(lines.join("\n"));
}

function printSettings({ settings, ceilings, inForce }) {
  for (const key of Object.keys(settings)) {
    const ceiling = ceilings[key] ? ` (deploy ceiling ${ceilings[key]})` : "";
    console.log(`${key.padEnd(22)} set ${String(settings[key]).padEnd(8)} in force ${inForce[key]}${ceiling}`);
  }
}

const [command, ...args] = process.argv.slice(2);
const { options, rest } = readOptions(command, args);
const test = () => ({ ...(options.days ? { days: whole("days", options.days) } : {}), ...(options.note ? { note: options.note } : {}) });

switch (command) {
  case "show":
    printAccount(await call("account", accountRef(rest[0])));
    break;
  case "act-as": {
    const plan = rest[1];
    if (!["free", "plus", "pro", "max"].includes(plan)) fail(`act-as takes free, plus, pro or max.\n\n${USAGE}`);
    printAccount(await call("account", { ...accountRef(rest[0]), plan, ...test() }));
    break;
  }
  case "limits": {
    const computers = whole("computers", options.computers);
    const hours = whole("hours", options.hours);
    const phoneMinutes = whole("phone-minutes", options["phone-minutes"]);
    const given = computers !== undefined || hours !== undefined || phoneMinutes !== undefined;
    printAccount(await call("account", {
      ...accountRef(rest[0]),
      computers: given ? computers : null,
      hours: given ? hours : null,
      phoneMinutes: given ? phoneMinutes : null,
      ...test(),
    }));
    break;
  }
  case "phone": {
    if (!["nomac", "revyl", "both", "off"].includes(rest[1])) fail(`phone takes nomac, revyl, both or off.\n\n${USAGE}`);
    printAccount(await call("account", { ...accountRef(rest[0]), phone: rest[1] }));
    break;
  }
  case "tester": {
    if (rest[1] !== "on" && rest[1] !== "off") fail(`tester takes on or off.\n\n${USAGE}`);
    printAccount(await call("account", { ...accountRef(rest[0]), tester: rest[1] === "on" }));
    break;
  }
  case "reset":
    printAccount(await call("account", { ...accountRef(rest[0]), reset: true }));
    break;
  case "settings":
    printSettings(await call("settings", {}));
    break;
  case "set":
    if (!rest[0] || !rest[1]) fail(`set takes a key and a value.\n\n${USAGE}`);
    printSettings(await call("settings", { key: rest[0], value: rest[1], ...(options.note ? { note: options.note } : {}) }));
    break;
  default:
    console.log(USAGE);
    process.exit(command ? 1 : 0);
}
