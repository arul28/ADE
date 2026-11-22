/**
 * Passwords: reading a login list another password manager exported.
 *
 * Every vendor writes the same kind of file, an RFC 4180 CSV with a header row,
 * and differs mostly in what the columns are called. So one real CSV reader
 * (quoted fields, doubled quotes, newlines inside quotes, CRLF or LF, BOM) and
 * one column lookup by name cover all of them; the detected format only picks
 * the vendor-specific details (Bitwarden's numeric item type, its several URIs
 * in one cell, and the "Imported from …" label).
 *
 * A row is kept only when it has a password and at least one `https` origin
 * (or a local one, see `passwordMatching.ts`). Everything else is counted in
 * `skippedInvalid` so the UI can say how many rows it left out. Android app
 * credentials (`android://…`) land there too: this vault has no app origin.
 *
 * A password never leaves this module: it produces the rows or an error about
 * the file, and no thrown message quotes a value.
 */
import { normalizeLoginOrigin, type NormalizedLoginOrigin } from "./passwordMatching";

export type ImportedLogin = {
  title: string;
  origins: string[];
  username: string;
  password: string;
  notes: string;
  totpUri: string | null;
};

export type PasswordCsvFormat = "apple" | "chrome" | "firefox" | "bitwarden" | "onepassword" | "generic";

export type ParsedPasswordCsv = {
  rows: ImportedLogin[];
  skippedInvalid: number;
  format: PasswordCsvFormat;
};

export type ExistingLoginKey = {
  origins: string[];
  username: string;
  password: string;
};

/** Bigger than any real export; also what keeps a mistaken file pick from hanging the app. */
export const MAX_PASSWORD_CSV_BYTES = 5 * 1024 * 1024;

const COLUMN_ALIASES = {
  title: ["title", "name", "item name"],
  url: ["url", "website", "login_uri", "urls", "site", "origin", "link"],
  username: ["username", "login_username", "user", "login", "email", "login name"],
  password: ["password", "login_password", "pass"],
  notes: ["notes", "note", "comments", "comment"],
  totp: ["otpauth", "login_totp", "one-time password", "one time password", "totp", "otp"],
  type: ["type"],
} as const;

/** Columns only Firefox writes, used to tell its export apart from a generic one. */
const FIREFOX_HINTS = ["httprealm", "formactionorigin", "guid", "timepasswordchanged"];

/** A base32 secret, which some exports store instead of an `otpauth://` URI. */
const BASE32_SECRET = /^[a-z2-7]+$/i;
const OTPAUTH_TOTP = /^otpauth:\/\/totp\//i;

type ColumnMap = Record<keyof typeof COLUMN_ALIASES, number>;

/**
 * Read a whole export. Throws only for an oversized file; a malformed or
 * unreadable row is skipped and counted.
 */
export function parsePasswordCsv(text: string): ParsedPasswordCsv {
  if (Buffer.byteLength(text, "utf8") > MAX_PASSWORD_CSV_BYTES) throw new Error("The file is over 5 MB.");
  const records = parseCsvRecords(text).filter((record) => record.some((cell) => cell.length > 0));
  const header = records.shift();
  if (!header) return { rows: [], skippedInvalid: 0, format: "generic" };
  const format = detectFormat(header);
  const columns = mapColumns(header);
  const rows: ImportedLogin[] = [];
  let skippedInvalid = 0;
  for (const cells of records) {
    // A Bitwarden vault also holds notes, cards and identities: not failed logins.
    if (format === "bitwarden" && !isBitwardenLogin(cellAt(cells, columns.type))) continue;
    const login = buildLogin(cells, columns);
    if (!login) {
      skippedInvalid += 1;
      continue;
    }
    rows.push(login);
  }
  return { rows, skippedInvalid, format };
}

/**
 * Drop rows the vault already holds. A duplicate is the same registrable
 * domain, username and password, checked against `existing` and against the
 * rows kept earlier in this import, so importing the same file twice adds
 * nothing and a changed password still imports.
 */
export function dedupeImportedLogins(
  rows: ImportedLogin[],
  existing: ExistingLoginKey[],
): { fresh: ImportedLogin[]; skippedDuplicate: number } {
  const seen = new Set<string>();
  for (const login of existing) {
    for (const key of credentialKeys(login.origins, login.username, login.password)) seen.add(key);
  }
  const fresh: ImportedLogin[] = [];
  let skippedDuplicate = 0;
  for (const row of rows) {
    const keys = credentialKeys(row.origins, row.username, row.password);
    if (keys.some((key) => seen.has(key))) {
      skippedDuplicate += 1;
      continue;
    }
    for (const key of keys) seen.add(key);
    fresh.push(row);
  }
  return { fresh, skippedDuplicate };
}

/** RFC 4180 records, with a leading BOM dropped. A trailing newline adds no row. */
function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
        continue;
      }
      field += char;
      continue;
    }
    if (char === '"' && field === "") {
      inQuotes = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function normalizeHeaderCell(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, " ");
}

function detectFormat(header: string[]): PasswordCsvFormat {
  const cells = new Set(header.map(normalizeHeaderCell));
  const has = (...names: string[]): boolean => names.every((name) => cells.has(name));
  if (has("login_uri", "login_password")) return "bitwarden";
  // Apple and 1Password ship the same columns and spell the URL header
  // differently ("URL" versus "Url"), as does 1Password's newer "Website"
  // export. The files read the same; the spelling only names the vendor.
  const otpColumn = cells.has("otpauth") || cells.has("one-time password") || cells.has("one time password");
  if (otpColumn && has("title", "username", "password") && (cells.has("url") || cells.has("website"))) {
    const onePassword = cells.has("website") || header.some((cell) => cell.trim() === "Url");
    return onePassword ? "onepassword" : "apple";
  }
  if (has("name", "url", "username", "password")) return "chrome";
  if (has("url", "username", "password") && FIREFOX_HINTS.some((hint) => cells.has(hint))) return "firefox";
  return "generic";
}

function mapColumns(header: string[]): ColumnMap {
  const cells = header.map(normalizeHeaderCell);
  const pick = (aliases: readonly string[]): number => {
    for (const alias of aliases) {
      const index = cells.indexOf(alias);
      if (index >= 0) return index;
    }
    return -1;
  };
  return {
    title: pick(COLUMN_ALIASES.title),
    url: pick(COLUMN_ALIASES.url),
    username: pick(COLUMN_ALIASES.username),
    password: pick(COLUMN_ALIASES.password),
    notes: pick(COLUMN_ALIASES.notes),
    totp: pick(COLUMN_ALIASES.totp),
    type: pick(COLUMN_ALIASES.type),
  };
}

function cellAt(row: string[], index: number): string {
  return index >= 0 ? row[index] ?? "" : "";
}

/** Bitwarden's item type: `1` (older exports) or `login`, and blank to be safe. */
function isBitwardenLogin(value: string): boolean {
  const type = value.trim().toLowerCase();
  return type === "" || type === "login" || type === "1";
}

function buildLogin(row: string[], columns: ColumnMap): ImportedLogin | null {
  const password = cellAt(row, columns.password);
  if (!password) return null;
  const origins = readOrigins(cellAt(row, columns.url));
  if (origins.length === 0) return null;
  const title = cellAt(row, columns.title).trim() || origins[0]!.host;
  return {
    title,
    origins: origins.map((origin) => origin.origin),
    username: cellAt(row, columns.username).trim(),
    password,
    notes: cellAt(row, columns.notes).trim(),
    totpUri: toTotpUri(cellAt(row, columns.totp), title),
  };
}

/** One cell can hold several sites: Bitwarden separates them with commas, 1Password with newlines. */
function readOrigins(value: string): NormalizedLoginOrigin[] {
  const origins: NormalizedLoginOrigin[] = [];
  const seen = new Set<string>();
  for (const candidate of value.split(/[,\r\n]+/)) {
    if (!candidate) continue;
    const normalized = normalizeLoginOrigin(candidate);
    if (!normalized || seen.has(normalized.origin)) continue;
    seen.add(normalized.origin);
    origins.push(normalized);
  }
  return origins;
}

/** A full `otpauth://totp/…` URI is kept; a bare base32 secret becomes one named after the login. */
function toTotpUri(value: string, title: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (OTPAUTH_TOTP.test(raw)) return raw;
  const secret = raw.replace(/[\s-]/g, "").replace(/=+$/, "");
  // 16 base32 characters is the shortest real TOTP secret; shorter text is not one.
  if (secret.length < 16 || !BASE32_SECRET.test(secret)) return null;
  return `otpauth://totp/${encodeURIComponent(title)}?secret=${secret.toUpperCase()}`;
}

/** The site is what dedupe compares, so two subdomains of one site count as one login. */
function credentialKeys(origins: string[], username: string, password: string): string[] {
  const keys = new Set<string>();
  for (const origin of origins) {
    const normalized = normalizeLoginOrigin(origin);
    if (!normalized) continue;
    keys.add(`${normalized.site}\u0000${username}\u0000${password}`);
  }
  return [...keys];
}
