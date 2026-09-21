function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function yesNo(value: unknown): string {
  return value === true ? "yes" : "no";
}

/** Render the machine-scoped subscription proxy status without credential fields. */
export function formatProxyStatus(value: unknown): string {
  const status = isRecord(value) ? value : {};
  const logins = Array.isArray(status.logins) ? status.logins.filter(isRecord) : [];
  const lines = [
    "ADE subscription proxy",
    `installed: ${yesNo(status.installed)}`,
    `running: ${yesNo(status.running)}`,
    `port: ${typeof status.port === "number" ? status.port : "—"}`,
    `version: ${text(status.version)}`,
    `logins: ${logins.length}`,
  ];

  for (const login of logins) {
    const provider = text(login.provider, "unknown");
    const email = text(login.email, "no email");
    const plan = text(login.plan, "plan unknown");
    const prefix = text(login.prefix, "no prefix");
    const state = login.disabled === true ? "disabled" : "enabled";
    lines.push(`  ${provider} · ${email} · ${plan} · ${prefix} · ${state} · ${text(login.loginId, "unknown id")}`);
  }

  return lines.join("\n");
}
