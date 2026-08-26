import AppKit
import SwiftUI
import ADEAttentionNotchCore

/// The provider marks the helper ships, resolved once and cached.
///
/// SVG rather than PNG because the same file has to look right at 18pt in a
/// row, 22pt on a card, and on both 1x and 2x displays. AppKit reads SVG into a
/// vector representation, so one asset covers all of it; the marks are the
/// monochrome Lobe glyphs, drawn as templates and tinted like any other symbol.
///
/// Droid is the exception and is deliberately not a template: its mark is a
/// full-colour badge that already draws its own disc, and flattening it to one
/// ink would leave a filled circle.
@MainActor
enum NotchProviderMark {
    struct Asset {
        let image: NSImage
        let isTemplate: Bool
    }

    /// Display names as `providerDisplayName` mints them, plus the raw ids in
    /// case a publisher sends those instead.
    ///
    /// Mirror this map with the renderer's provider→mark tables so the same
    /// provider never wears two different marks across ADE's surfaces:
    /// `ProviderLogo` in
    /// `apps/desktop/src/renderer/components/shared/ProviderLogos.tsx`
    /// (provider ids and aliases) and `LOGO_MAP` in
    /// `apps/desktop/src/renderer/components/terminals/ToolLogos.tsx`
    /// (terminal tool types).
    private static let fileByProvider: [String: String] = [
        "claude": "claude",
        "anthropic": "claude",
        "codex": "openai",
        "openai": "openai",
        "cursor": "cursor",
        "droid": "droid",
        "factory": "droid",
        "opencode": "opencode",
        "pi": "pi",
        "gemini": "gemini",
        "google": "gemini",
        "github": "github",
    ]

    private static let colorMarks: Set<String> = ["droid"]

    /// Memoized by file name, and the value is deliberately a double optional:
    /// the outer layer answers "has this file been looked up yet", the inner
    /// one "did the lookup produce an image". A single optional could only say
    /// "no image", which would send every provider whose mark is missing back
    /// through `Bundle.module` and `NSImage(contentsOf:)` on every redraw.
    private static var cache: [String: Asset?] = [:]

    static func asset(for provider: String?) -> Asset? {
        guard let key = provider?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !key.isEmpty,
              let file = fileByProvider[key] else { return nil }
        if let cached = cache[file] { return cached }
        let resolved = load(file)
        cache[file] = resolved
        return resolved
    }

    private static func load(_ file: String) -> Asset? {
        guard let url = Bundle.module.url(forResource: file, withExtension: "svg")
            ?? Bundle.module.url(
                forResource: file,
                withExtension: "svg",
                subdirectory: "ProviderIcons"
            ),
            let image = NSImage(contentsOf: url) else { return nil }
        // The Lobe marks declare `1em` and land as a 1×1 vector image. Give the
        // representation a real square to draw into so nothing downstream is
        // ever tempted to rasterize a one-point source and scale it up.
        image.size = NSSize(width: 64, height: 64)
        let isTemplate = !colorMarks.contains(file)
        image.isTemplate = isTemplate
        return Asset(image: image, isTemplate: isTemplate)
    }

    /// What a provider with no shipped mark falls back to. Never an empty
    /// circle: a letter still tells you which agent this row belongs to.
    /// `nil` when there is no provider to name at all — privacy mode, or an
    /// item from a publisher that does not send one — where the mark falls all
    /// the way back to the state symbol it has always drawn.
    static func monogram(for provider: String?) -> String? {
        let trimmed = provider?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard let first = trimmed.first(where: { $0.isLetter || $0.isNumber }) else { return nil }
        return String(first).uppercased()
    }
}

/// The row and card mark: whose work this is, and what it is doing.
///
/// Two facts, and they were fighting over one glyph. The disc used to carry
/// only the state symbol, so a screen of amber circles told you five things
/// needed you and nothing about which agent any of them was. Now the provider
/// logo owns the disc and the state rides as a dot on its corner — the same
/// tone table, just no longer the only thing being said.
struct NotchItemMark: View {
    let provider: String?
    /// Privacy mode names nobody, so the disc falls all the way back to the
    /// state symbol. Decided here rather than at each call site: every caller
    /// was writing the same `hideDetails ? nil : provider`, and one of them
    /// forgetting is exactly how a hidden feed leaks whose work it is.
    var hideDetails: Bool = false
    let kind: NotchStripGroupKind
    var diameter: CGFloat = 18

    private var namedProvider: String? { hideDetails ? nil : provider }

    var body: some View {
        let tone = notchToneColor(kind.tone)
        ZStack(alignment: .bottomTrailing) {
            ZStack {
                Circle().fill(hasProviderIdentity ? .white.opacity(0.07) : tone.opacity(0.16))
                Circle().strokeBorder(
                    hasProviderIdentity ? ADE.hairline : tone.opacity(0.24),
                    lineWidth: 0.5
                )
                logo
            }
            .frame(width: diameter, height: diameter)

            // The state dot, ringed in the surface colour so it reads as sitting
            // on top of the logo rather than punched out of it. With no
            // provider identity the disc already IS the state, so the dot would
            // just say it twice.
            if hasProviderIdentity {
                Circle()
                    .fill(tone)
                    .frame(width: dotDiameter, height: dotDiameter)
                    .overlay(Circle().strokeBorder(ADE.bg, lineWidth: dotDiameter * 0.22))
                    .offset(x: dotDiameter * 0.20, y: dotDiameter * 0.20)
            }
        }
        .frame(width: diameter, height: diameter, alignment: .center)
        .accessibilityHidden(true)
    }

    private var asset: NotchProviderMark.Asset? { NotchProviderMark.asset(for: namedProvider) }
    private var monogram: String? { NotchProviderMark.monogram(for: namedProvider) }
    private var hasProviderIdentity: Bool { asset != nil || monogram != nil }

    @ViewBuilder
    private var logo: some View {
        if let asset {
            Image(nsImage: asset.image)
                .resizable()
                .renderingMode(asset.isTemplate ? .template : .original)
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .foregroundStyle(ADE.fg.opacity(0.92))
                .frame(width: glyphSize, height: glyphSize)
                .clipShape(Circle())
        } else if let monogram {
            Text(monogram)
                .font(.system(size: diameter * 0.46, weight: .semibold, design: .rounded))
                .foregroundStyle(ADE.fg.opacity(0.85))
        } else {
            Image(systemName: kind.symbolName)
                .font(.system(size: stateGlyphSize, weight: .bold))
                .foregroundStyle(notchToneColor(kind.tone))
        }
    }

    /// Colour marks draw their own disc, so they fill it; template marks are
    /// glyphs and need the disc's padding around them.
    private var glyphSize: CGFloat {
        asset?.isTemplate == false ? diameter : diameter * 0.58
    }

    private var stateGlyphSize: CGFloat {
        switch kind {
        case .needsYou: return diameter * 0.40
        case .working: return diameter * 0.44
        case .idle, .done: return diameter * 0.50
        case .failed, .planning: return diameter * 0.47
        }
    }

    private var dotDiameter: CGFloat { max(6, diameter * 0.36) }
}
