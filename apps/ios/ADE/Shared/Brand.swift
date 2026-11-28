import Foundation

/// The product's public names, for copy the iOS app, widgets and App Clip show.
///
/// The product was called ADE and is now DAEX. Internal identifiers keep the
/// old name on purpose: the bundle IDs (`com.ade.ios*`), the app group
/// (`group.com.ade.ios*`), keychain services, Bonjour `_ade-sync._tcp` and
/// type names like `ADESharedTheme`. The list and the reasons are in
/// docs/brand/README.md.
///
/// This mirrors `BRAND` in apps/desktop/src/shared/brand.ts; change both
/// together.
public enum Brand {
    /// Display name, written in capitals: "DAEX" (said "dax"; "a DAEX chat").
    public static let name = "DAEX"
    /// The name the product had before; for "formerly ADE" notes.
    public static let formerName = "ADE"
    /// First mention in onboarding and What's New.
    public static let introName = "\(name) (formerly \(formerName))"
    /// Primary CLI command, for copy that tells the user what to type.
    public static let cliName = "daex"
    public static let siteURL = URL(string: "https://daex.dev")!
    public static let cloudName = "\(name) Cloud"
    public static let betaName = "\(name) Beta"

    /// Every deep link scheme the app registers (`CFBundleURLSchemes`) and its
    /// parsers accept: `ade`, `daex`, and the Beta app's `ade-beta` and
    /// `daex-beta`. Mirrors `BRAND.LINK_SCHEMES` on desktop.
    public static let linkSchemes: Set<String> = ["ade", "daex", "ade-beta", "daex-beta"]
    /// The scheme newly made links use: `daex`. The account server's minimum
    /// version keeps every app that registers only `ade://` from running.
    /// Mirrors `BRAND.LINK_SCHEME_FOR_NEW_LINKS` on desktop.
    public static let linkSchemeForNewLinks = "daex"

    /// The GitHub App's slug ("DAEX for GitHub"); the install page is
    /// `github.com/apps/<slug>/installations/new`. Mirrors `GITHUB_APP_SLUG`
    /// in apps/desktop/src/shared/github/githubAppIdentity.ts.
    public static let githubAppSlug = "daex-for-github"
    /// Every slug the app has had, current first. Bot comments and check runs
    /// made before the rename keep `ade-for-github`. Mirrors `GITHUB_APP_SLUGS`.
    public static let githubAppSlugs = [githubAppSlug, "ade-for-github"]
}
