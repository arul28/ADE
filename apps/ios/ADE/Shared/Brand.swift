import Foundation

/// The product's public names, for copy the iOS app, widgets and App Clip show.
///
/// The product was called ADE and is now Daex. Internal identifiers keep the
/// old name on purpose: the bundle IDs (`com.ade.ios*`), the app group
/// (`group.com.ade.ios*`), keychain services, Bonjour `_ade-sync._tcp` and
/// type names like `ADESharedTheme`. The list and the reasons are in
/// docs/brand/README.md.
///
/// This mirrors `BRAND` in apps/desktop/src/shared/brand.ts; change both
/// together.
public enum Brand {
    /// Display name. Always "Daex", never "DAEX".
    public static let name = "Daex"
    /// The name the product had before; for "formerly ADE" notes.
    public static let formerName = "ADE"
    /// First mention in onboarding and What's New.
    public static let introName = name == formerName ? name : "\(name) (formerly \(formerName))"
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
}
