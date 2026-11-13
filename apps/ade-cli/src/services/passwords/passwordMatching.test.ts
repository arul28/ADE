import { describe, expect, it } from "vitest";
import { matchLoginsForOrigin, normalizeLoginOrigin } from "./passwordMatching";

describe("normalizeLoginOrigin", () => {
  it.each([
    { name: "a bare host", input: "github.com", origin: "https://github.com", host: "github.com", site: "github.com" },
    {
      name: "a full URL with a path and a query, lowercased",
      input: "https://GitHub.com/settings?tab=keys",
      origin: "https://github.com",
      host: "github.com",
      site: "github.com",
    },
    {
      name: "a default port, which is dropped",
      input: "https://github.com:443/login",
      origin: "https://github.com",
      host: "github.com",
      site: "github.com",
    },
    {
      name: "a non-default port, which is kept",
      input: "https://example.com:8443/admin",
      origin: "https://example.com:8443",
      host: "example.com",
      site: "example.com",
    },
    {
      name: "an international name, punycoded",
      input: "https://münchen.de",
      origin: "https://xn--mnchen-3ya.de",
      host: "xn--mnchen-3ya.de",
      site: "xn--mnchen-3ya.de",
    },
    {
      name: "a subdomain, whose site is the registrable domain",
      input: "https://login.github.com/session",
      origin: "https://login.github.com",
      host: "login.github.com",
      site: "github.com",
    },
    {
      name: "a multi-label public suffix",
      input: "https://www.bbc.co.uk/news",
      origin: "https://www.bbc.co.uk",
      host: "www.bbc.co.uk",
      site: "bbc.co.uk",
    },
    {
      name: "an IPv4 address, which is its own site",
      input: "https://192.168.1.10",
      origin: "https://192.168.1.10",
      host: "192.168.1.10",
      site: "192.168.1.10",
    },
    {
      name: "an IPv6 address with a port",
      input: "https://[::1]:8443",
      origin: "https://[::1]:8443",
      host: "::1",
      site: "::1",
    },
  ])("reads $name", ({ input, origin, host, site }) => {
    expect(normalizeLoginOrigin(input)).toEqual({ origin, host, site });
  });

  it.each([
    { name: "a site over plain http", input: "http://github.com" },
    { name: "an IP address over plain http", input: "http://192.168.1.10" },
    { name: "an ftp URL", input: "ftp://example.com/files" },
    { name: "an Android app credential", input: "android://x7y8z9@com.example.app/" },
    { name: "a browser extension", input: "chrome-extension://abcdefghijklmnop/options.html" },
    { name: "a mailto link", input: "mailto:ada@example.com" },
    { name: "a javascript URL", input: "javascript:alert(1)" },
    { name: "an empty string", input: "" },
    { name: "whitespace", input: "   " },
    { name: "text that is not a URL", input: "not a url" },
  ])("refuses $name", ({ input }) => {
    expect(normalizeLoginOrigin(input)).toBeNull();
  });

  it.each([
    { name: "localhost with a port", input: "http://localhost:3000", origin: "http://localhost:3000" },
    { name: "a *.localhost name", input: "http://app.localhost:5173", origin: "http://app.localhost:5173" },
    { name: "127.0.0.1", input: "http://127.0.0.1:8080/login", origin: "http://127.0.0.1:8080" },
    { name: "[::1]", input: "http://[::1]:3000", origin: "http://[::1]:3000" },
    { name: "a bare ::1", input: "::1", origin: "http://[::1]" },
  ])("allows $name over http", ({ input, origin }) => {
    expect(normalizeLoginOrigin(input)?.origin).toBe(origin);
  });
});

describe("matchLoginsForOrigin", () => {
  it.each([
    { name: "the same host", page: "https://github.com/settings/profile", saved: ["https://github.com"], matches: true },
    { name: "a deeper subdomain", page: "https://gist.github.com/octocat", saved: ["https://github.com"], matches: true },
    { name: "a sibling subdomain", page: "https://gist.github.com", saved: ["https://login.github.com"], matches: true },
    { name: "a saved subdomain on its apex", page: "https://google.com", saved: ["https://accounts.google.com"], matches: true },
    { name: "a saved URL path", page: "https://github.com", saved: ["https://github.com/login?return_to=%2F"], matches: true },
    {
      name: "a domain that ends in the saved name",
      page: "https://github.com.evil.io/login",
      saved: ["https://github.com"],
      matches: false,
    },
    { name: "one letter more", page: "https://githubb.com", saved: ["https://github.com"], matches: false },
    // The punycode for "gіthub.com", with a Cyrillic і: it renders like the real thing.
    { name: "a punycode lookalike", page: "https://xn--gthub-n2e.com", saved: ["https://github.com"], matches: false },
    { name: "a country suffix", page: "https://github.com.br", saved: ["https://github.com"], matches: false },
    {
      name: "a tenant of a private suffix",
      page: "https://someone.github.io/repo",
      saved: ["https://alice.github.io"],
      matches: false,
    },
    { name: "a host written inside a path", page: "https://evil.io/github.com", saved: ["https://github.com"], matches: false },
    { name: "a different local port", page: "http://localhost:3001", saved: ["http://localhost:3000"], matches: false },
    { name: "the same local app", page: "http://localhost:3000/login", saved: ["http://localhost:3000"], matches: true },
    { name: "another loopback port", page: "http://127.0.0.1:9000", saved: ["http://127.0.0.1:8080"], matches: false },
    { name: "the same loopback app", page: "http://127.0.0.1:8080/x", saved: ["http://127.0.0.1:8080"], matches: true },
  ])("$name is $matches for the page", ({ page, saved, matches }) => {
    const savedLogin = { id: "saved", origins: saved };
    expect(matchLoginsForOrigin([savedLogin], page)).toEqual(matches ? [savedLogin] : []);
  });

  it("offers an exact host before the rest of the site, keeping the caller's order", () => {
    const subdomain = { id: "subdomain", origins: ["https://gist.github.com"] };
    const sibling = { id: "sibling", origins: ["https://login.github.com"] };
    const exact = { id: "exact", origins: ["https://github.com"] };
    expect(matchLoginsForOrigin([subdomain, sibling, exact], "https://github.com/notifications")).toEqual([
      exact,
      subdomain,
      sibling,
    ]);
    expect(matchLoginsForOrigin([subdomain, exact], "https://gist.github.com/octocat")).toEqual([subdomain, exact]);
  });

  it("offers a login once even when several of its origins match", () => {
    const login = { id: "many", origins: ["https://github.com", "https://gist.github.com", "https://gitlab.com"] };
    expect(matchLoginsForOrigin([login], "https://gist.github.com")).toEqual([login]);
  });

  it("ignores origins it cannot read and pages that are not http(s)", () => {
    const unreadable = { id: "unreadable", origins: ["android://x7y8z9@com.example.app/", "not a url", ""] };
    const empty = { id: "empty", origins: [] };
    const readable = { id: "readable", origins: ["https://github.com"] };
    expect(matchLoginsForOrigin([unreadable, empty, readable], "https://github.com")).toEqual([readable]);
    expect(matchLoginsForOrigin([readable], "ftp://github.com")).toEqual([]);
    expect(matchLoginsForOrigin([readable], "")).toEqual([]);
  });
});
