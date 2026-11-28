/**
 * The product's public names: what a person sees, types or links to.
 *
 * The product was called ADE and is now DAEX. Copy, CLI help, links and
 * install commands read these names from here. Internal identifiers (bundle
 * IDs, keychain services, `.ade/`, `ADE_*` env names, `window.ade`, wire
 * strings, Worker names) keep the old name on purpose; the list and the
 * reasons are in docs/brand/README.md. The iOS copy is
 * apps/ios/ADE/Shared/Brand.swift; change both together.
 *
 * No imports: the CLI, the web client, the marketing site and build configs
 * import this file directly.
 */

const NAME = "DAEX";
const FORMER_NAME = "ADE";

export const BRAND = Object.freeze({
  /** Display name, written in capitals: "DAEX" (said "dax"; "a DAEX chat"). */
  NAME,
  /** The name the product had before; for "formerly ADE" notes and search. */
  FORMER_NAME,
  /** First mention in onboarding, release notes and the site. */
  INTRO_NAME: `${NAME} (formerly ${FORMER_NAME})`,

  /** Primary CLI command. */
  CLI: "daex",
  /** The old command; stays installed as a permanent alias. */
  LEGACY_CLI: "ade",

  /** Old domain. Sign-in and API hosts stay here while released clients call them. */
  LEGACY_DOMAIN: "ade-app.dev",

  /**
   * Every scheme the apps register with the OS and every link parser accepts.
   * Desktop: `build.protocols` in apps/desktop/package.json and
   * `registerAdeProtocolHandler`; iOS: `CFBundleURLSchemes` in
   * apps/ios/ADE/Info.plist.
   */
  LINK_SCHEMES: ["ade", "daex"],
  /**
   * The scheme newly made links use: `daex`. The account server's minimum
   * version (`clientUpdateGate.ts`) keeps every app that registers only
   * `ade://` from running, so nothing has to mint `ade://` links any more.
   * The iOS copy is `Brand.linkSchemeForNewLinks`.
   */
  LINK_SCHEME_FOR_NEW_LINKS: "daex",

  /** Feature names. */
  CLOUD_NAME: `${NAME} Cloud`,
  BETA_NAME: `${NAME} Beta`,
} as const);

export type Brand = typeof BRAND;
