import { describe, expect, it } from "vitest";
import {
  MAX_PASSWORD_CSV_BYTES,
  dedupeImportedLogins,
  parsePasswordCsv,
  type ImportedLogin,
  type PasswordCsvFormat,
} from "./passwordCsvImport";

const CHROME_HEADER = "name,url,username,password,note";
const APPLE_HEADER = "Title,URL,Username,Password,Notes,OTPAuth";

function login(overrides: Partial<ImportedLogin> = {}): ImportedLogin {
  return {
    title: "GitHub",
    origins: ["https://github.com"],
    username: "ada@example.com",
    password: "correct horse battery staple",
    notes: "",
    totpUri: null,
    ...overrides,
  };
}

describe("parsePasswordCsv", () => {
  const vendorSamples: Array<{ name: string; csv: string; format: PasswordCsvFormat; rows: ImportedLogin[] }> = [
    {
      name: "an Apple Passwords export",
      format: "apple",
      csv: [
        "Title,URL,Username,Password,Notes,OTPAuth",
        "GitHub,https://github.com,ada.lovelace@example.com,correct horse battery staple,Work account,otpauth://totp/GitHub:ada.lovelace@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
        'Fastmail,https://app.fastmail.com,ada@example.com,"3,1415 and ""more""",Personal mail,',
      ].join("\r\n"),
      rows: [
        login({
          title: "GitHub",
          origins: ["https://github.com"],
          username: "ada.lovelace@example.com",
          notes: "Work account",
          totpUri: "otpauth://totp/GitHub:ada.lovelace@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
        }),
        login({
          title: "Fastmail",
          origins: ["https://app.fastmail.com"],
          username: "ada@example.com",
          password: '3,1415 and "more"',
          notes: "Personal mail",
        }),
      ],
    },
    {
      name: "a Chrome export",
      format: "chrome",
      csv: [
        CHROME_HEADER,
        "Linear,https://linear.app,ada@example.com,marginal-utility-note,Team planning",
        'Figma,https://www.figma.com/login,ada@example.com,"design, review, ship",Imported from Chrome',
      ].join("\n"),
      rows: [
        login({
          title: "Linear",
          origins: ["https://linear.app"],
          password: "marginal-utility-note",
          notes: "Team planning",
        }),
        login({
          title: "Figma",
          origins: ["https://www.figma.com"],
          password: "design, review, ship",
          notes: "Imported from Chrome",
        }),
      ],
    },
    {
      name: "a Firefox export, whose rows have no title",
      format: "firefox",
      csv: [
        "url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged",
        "https://news.ycombinator.com/login,ada,orange-tab-42,,https://news.ycombinator.com,{c0ffee00-1111-2222-3333-444455556666},1699999999000,1699999999000,1699999999000",
      ].join("\n"),
      rows: [
        login({
          title: "news.ycombinator.com",
          origins: ["https://news.ycombinator.com"],
          username: "ada",
          password: "orange-tab-42",
        }),
      ],
    },
    {
      name: "a Bitwarden export, keeping only its logins",
      format: "bitwarden",
      csv: [
        "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
        'Personal,0,1,Canvas,Learning,"",0,"https://canvas.instructure.com, https://school.instructure.com",ada@example.com,sketchbook-1999,',
        "Work,0,1,Vercel,,,0,https://vercel.com/login,ada@example.com,atomic-deploy-77,JBSWY3DPEHPK3PXP",
        "Personal,0,2,Passport scan,,,0,,,,",
      ].join("\n"),
      rows: [
        login({
          title: "Canvas",
          origins: ["https://canvas.instructure.com", "https://school.instructure.com"],
          password: "sketchbook-1999",
          notes: "Learning",
        }),
        login({
          title: "Vercel",
          origins: ["https://vercel.com"],
          password: "atomic-deploy-77",
          totpUri: "otpauth://totp/Vercel?secret=JBSWY3DPEHPK3PXP",
        }),
      ],
    },
    {
      name: "a 1Password export with its newer column names",
      format: "onepassword",
      csv: [
        "Title,Website,Username,Password,One-Time Password,Notes",
        'Fastmail,https://app.fastmail.com,ada@example.com,marginal-utility,otpauth://totp/Fastmail:ada@example.com?secret=KRSXG5DSN5XGK4TF,"Mail, calendar and files"',
      ].join("\n"),
      rows: [
        login({
          title: "Fastmail",
          origins: ["https://app.fastmail.com"],
          password: "marginal-utility",
          notes: "Mail, calendar and files",
          totpUri: "otpauth://totp/Fastmail:ada@example.com?secret=KRSXG5DSN5XGK4TF",
        }),
      ],
    },
    {
      name: "a 1Password export with the shared Apple column names",
      format: "onepassword",
      csv: ["Title,Url,Username,Password,Notes,OTPAuth", "Cloudflare,https://dash.cloudflare.com,ada@example.com,tunnel-vision-88,,"].join(
        "\n",
      ),
      rows: [
        login({
          title: "Cloudflare",
          origins: ["https://dash.cloudflare.com"],
          password: "tunnel-vision-88",
        }),
      ],
    },
    {
      name: "a generic export, finding the columns by name",
      format: "generic",
      csv: ["Site,Login,Pass,Comment", "https://example.org/login,ada,orchid-notes,imported by hand"].join("\n"),
      rows: [
        login({
          title: "example.org",
          origins: ["https://example.org"],
          username: "ada",
          password: "orchid-notes",
          notes: "imported by hand",
        }),
      ],
    },
  ];

  it.each(vendorSamples)("reads $name", ({ csv, format, rows }) => {
    expect(parsePasswordCsv(csv)).toEqual({ rows, skippedInvalid: 0, format });
  });

  it("keeps newlines inside quoted fields", () => {
    const parsed = parsePasswordCsv(
      [
        CHROME_HEADER,
        'Linear,https://linear.app,ada@example.com,quoted-newline,"Line one\nLine two, with a comma"',
      ].join("\r\n"),
    );
    expect(parsed.rows[0]?.notes).toBe("Line one\nLine two, with a comma");
    expect(parsed.rows).toHaveLength(1);
  });

  it.each([
    { name: "LF line endings", csv: `${CHROME_HEADER}\nLinear,https://linear.app,ada,pass,` },
    { name: "CRLF line endings", csv: `${CHROME_HEADER}\r\nLinear,https://linear.app,ada,pass,` },
    { name: "a BOM", csv: `\uFEFF${CHROME_HEADER}\nLinear,https://linear.app,ada,pass,` },
    { name: "a BOM and CRLF", csv: `\uFEFF${CHROME_HEADER}\r\nLinear,https://linear.app,ada,pass,` },
  ])("reads a file with $name", ({ csv }) => {
    const parsed = parsePasswordCsv(csv);
    expect(parsed.format).toBe("chrome");
    expect(parsed.rows).toEqual([
      login({ title: "Linear", origins: ["https://linear.app"], username: "ada", password: "pass" }),
    ]);
  });

  it.each([
    { name: "a row with no password", row: "No password,https://example.com,ada,,", skipped: 1 },
    { name: "a site over plain http", row: "Plain http,http://example.com,ada,pass,", skipped: 1 },
    { name: "an Android app credential", row: "Android,android://x7y8z9@com.example.app/,ada,pass,", skipped: 1 },
    { name: "a row with no URL", row: "No URL,,ada,pass,", skipped: 1 },
    { name: "a row whose URL is unreadable", row: "Junk,not a url,ada,pass,", skipped: 1 },
    { name: "localhost", row: "Vite,http://localhost:5173,ada,pass,", skipped: 0 },
    { name: "loopback", row: "Dev server,http://127.0.0.1:3000,ada,pass,", skipped: 0 },
  ])("counts $name as invalid only when it cannot be saved", ({ row, skipped }) => {
    expect(parsePasswordCsv([CHROME_HEADER, row].join("\n")).skippedInvalid).toBe(skipped);
  });

  it("keeps the readable origins of a row that lists several URLs", () => {
    const parsed = parsePasswordCsv(
      [CHROME_HEADER, 'Two sites,"https://example.com, http://insecure.example.com",ada,pass,'].join("\n"),
    );
    expect(parsed.rows[0]?.origins).toEqual(["https://example.com"]);
    expect(parsed.skippedInvalid).toBe(0);
  });

  it.each([
    {
      name: "a full otpauth URI",
      cell: "otpauth://totp/GitHub:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
      expected: "otpauth://totp/GitHub:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
    },
    {
      name: "a bare base32 secret",
      cell: "JBSWY3DPEHPK3PXP",
      expected: "otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP",
    },
    {
      name: "a secret grouped with spaces, dashes and padding",
      cell: "jbsw y3dp-ehpk 3pxp====",
      expected: "otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP",
    },
    {
      name: "a counter-based HOTP URI, which is not a TOTP",
      cell: "otpauth://hotp/GitHub?secret=JBSWY3DPEHPK3PXP&counter=1",
      expected: null,
    },
    { name: "an empty value", cell: "", expected: null },
    { name: "text that is not a secret", cell: "two factor", expected: null },
  ])("reads $name in the TOTP column", ({ cell, expected }) => {
    const parsed = parsePasswordCsv([APPLE_HEADER, `GitHub,https://github.com,ada,pass,,${cell}`].join("\n"));
    expect(parsed.rows[0]?.totpUri).toBe(expected);
  });

  it("refuses a file over 5 MB without quoting its contents", () => {
    const row = "GitHub,https://github.com,ada,hunter2,hunter2\n";
    const oversized = CHROME_HEADER + "\n" + row.repeat(Math.ceil(MAX_PASSWORD_CSV_BYTES / row.length) + 1);
    expect(() => parsePasswordCsv(oversized)).toThrow("The file is over 5 MB.");
    let message = "";
    try {
      parsePasswordCsv(oversized);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("hunter2");
  });

  it("accepts a file at the 5 MB limit", () => {
    const atLimit = `${CHROME_HEADER}\n${"x".repeat(MAX_PASSWORD_CSV_BYTES - CHROME_HEADER.length - 1)}`;
    expect(() => parsePasswordCsv(atLimit)).not.toThrow();
  });

  it.each([
    { name: "an empty file", text: "" },
    { name: "a BOM alone", text: "\uFEFF" },
    { name: "blank lines", text: "\n\r\n" },
  ])("reads $name as no rows", ({ text }) => {
    expect(parsePasswordCsv(text)).toEqual({ rows: [], skippedInvalid: 0, format: "generic" });
  });
});

describe("dedupeImportedLogins", () => {
  it("skips a login the vault already holds, or that an earlier row in the file added", () => {
    const rows = [
      login({ title: "GitHub", origins: ["https://github.com"] }),
      login({ title: "GitHub on a subdomain", origins: ["https://gist.github.com"] }),
      login({ title: "A new password", password: "changed-but-here" }),
      login({ title: "Another user", username: "grace@example.com" }),
      login({ title: "A lookalike site", origins: ["https://github.com.evil.io"] }),
      login({ title: "Already saved", origins: ["https://gitlab.com"] }),
    ];
    const existing = [{ origins: ["https://gitlab.com"], username: "ada@example.com", password: "correct horse battery staple" }];

    expect(dedupeImportedLogins(rows, existing)).toEqual({
      fresh: [rows[0], rows[2], rows[3], rows[4]],
      skippedDuplicate: 2,
    });
  });

  it("keeps a login whose site cannot be read", () => {
    const rows = [login({ title: "Unreadable", origins: ["android://x7y8z9@com.example.app/"] })];
    expect(dedupeImportedLogins(rows, []).fresh).toEqual(rows);
  });
});
