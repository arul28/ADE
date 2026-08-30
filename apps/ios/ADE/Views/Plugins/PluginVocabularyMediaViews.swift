import SwiftUI
import UIKit
import AVKit

/// Media, action controls, and the degradation markers for the vocabulary
/// renderer. Split out of `PluginVocabularyView.swift` for length; the node
/// switch there dispatches into these.

// MARK: - Media

struct PluginVocabVideoView: View {
  let video: PluginVocabVideo

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let url = PluginMediaURL.resolve(video.src) {
        PluginVideoPlayerView(url: url)
      } else {
        PluginInlineEmptyText(text: "This video is not playable from your phone.")
      }
      if let title = video.title {
        Text(title)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
  }
}

/// Owns the `AVPlayer` so it survives the redraws a panel reload causes. Same
/// shape as `WorkArtifactVideoPlayerView`.
private struct PluginVideoPlayerView: View {
  let url: URL
  @StateObject private var model: WorkArtifactVideoPlayerModel

  init(url: URL) {
    self.url = url
    _model = StateObject(wrappedValue: WorkArtifactVideoPlayerModel(url: url))
  }

  var body: some View {
    VideoPlayer(player: model.player)
      .frame(height: 200)
      .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      .onChange(of: url) { _, newValue in
        model.update(url: newValue)
      }
  }
}

struct PluginVocabImageView: View {
  let image: PluginVocabImage

  var body: some View {
    if let url = PluginMediaURL.resolve(image.src) {
      AsyncImage(url: url) { phase in
        switch phase {
        case let .success(loaded):
          loaded
            .resizable()
            .scaledToFit()
            .frame(maxHeight: image.maxHeight.map { CGFloat($0) } ?? 260)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        case .failure:
          PluginInlineEmptyText(text: image.alt)
        default:
          ADESkeletonView(height: 120, cornerRadius: 12)
        }
      }
      .accessibilityLabel(image.alt)
    } else {
      PluginInlineEmptyText(text: image.alt)
    }
  }
}

/// Schemes a panel may point media at: `https` is the network case and `data`
/// the self-contained one.
///
/// A `src` is a string from another machine that this renderer turns into a
/// fetch, so everything else is a capability the plugin was never granted —
/// `file:` reads the phone's own disk, plain `http:` puts a panel's contents on
/// the wire in the clear, and a custom scheme hands the OS a launch. A relative
/// path has no scheme at all and is refused rather than resolved. The same rule
/// is enforced on desktop in `vocabularyComponents.tsx`.
enum PluginMediaURL {
  static func resolve(_ raw: String) -> URL? {
    guard let url = URL(string: raw), let scheme = url.scheme?.lowercased() else { return nil }
    return ["https", "data"].contains(scheme) ? url : nil
  }
}

/// The same rule for the one link a plugin can put in front of the user: a
/// fallback card's `deeplink`. `ade://` routes back through `DeepLinkRouter`
/// and `https` leaves the app through the browser; anything else — `file:`,
/// another app's custom scheme — would hand a plugin a tap-to-launch primitive
/// it was never granted.
///
/// The scheme alone is not the whole rule. `ade://` covers more than
/// navigation: `ade://pair#<payload>` walks straight into the pairing flow
/// carrying a payload the plugin chose, which is a state change and not a
/// destination. So a plugin's link is held to the navigation hosts — the ones
/// `DeepLinkRouter` resolves to a screen or a send-to-Mac card — and every
/// other host, including one a later build adds, is refused.
enum PluginDeeplinkURL {
  /// `repo` is the branch shape (`ade://repo/<owner>/<repo>/branch/<branch>`);
  /// there is no `ade://branch` host.
  private static let navigationHosts: Set<String> = [
    "lane",
    "session",
    "file",
    "commit",
    "artifact",
    "repo",
    "pr",
    "linear-issue",
  ]

  static func resolve(_ raw: String?) -> URL? {
    guard let raw, let url = URL(string: raw), let scheme = url.scheme?.lowercased() else { return nil }
    switch scheme {
    case "https":
      return url
    case "ade":
      guard let host = url.host?.lowercased(), navigationHosts.contains(host) else { return nil }
      return url
    default:
      return nil
    }
  }
}

// MARK: - Actions

struct PluginVocabButtonView: View {
  let button: PluginVocabButton
  @ObservedObject var store: PluginPaneStore

  private var isBusy: Bool { store.isInFlight(button.onPress) }
  private var isDisabled: Bool { button.disabled || isBusy || !store.canInvoke }

  var body: some View {
    Button {
      ADEHaptics.light()
      // The label rides along so a `{prompt}` that named no title of its own is
      // asked under the words the reader actually pressed.
      store.perform(button.onPress, label: button.label)
    } label: {
      HStack(spacing: 6) {
        if isBusy {
          ProgressView().controlSize(.mini)
        } else if PluginSymbol.drawsIcon(button.icon) {
          PluginSymbol.glyph(button.icon, fallback: "puzzlepiece.extension", pointSize: 11)
        }
        Text(button.label)
          .font(.caption.weight(.semibold))
      }
      .foregroundStyle(foreground)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(background, in: Capsule())
      .glassEffect()
      .overlay(Capsule().stroke(ADEColor.border.opacity(button.kind == .quiet ? 0 : 0.18), lineWidth: 0.5))
    }
    .buttonStyle(ADEScaleButtonStyle())
    .disabled(isDisabled)
    .opacity(isDisabled && !isBusy ? 0.5 : 1)
  }

  private var foreground: Color {
    switch button.kind {
    case .primary: return ADEColor.accent
    case .default: return ADEColor.textPrimary
    case .quiet: return ADEColor.textSecondary
    }
  }

  private var background: Color {
    switch button.kind {
    case .primary: return ADEColor.accent.opacity(0.14)
    case .default: return ADEColor.surfaceBackground.opacity(0.5)
    case .quiet: return .clear
    }
  }
}

struct PluginVocabEmptyStateView: View {
  let emptyState: PluginVocabEmptyState
  @ObservedObject var store: PluginPaneStore

  var body: some View {
    // Symbol tokens only: `ADEEmptyStateView` takes a symbol NAME and draws it
    // as the large centred mark of a whole empty page. A `brand:` token falls
    // through to the puzzle piece here rather than putting a vendor's logo at
    // hero size on a page that is about the panel being empty, not about whose
    // plugin it is.
    ADEEmptyStateView(
      symbol: PluginSymbol.resolve(emptyState.icon, fallback: "puzzlepiece.extension"),
      title: emptyState.title,
      message: emptyState.description ?? ""
    ) {
      if let label = emptyState.actionLabel, let action = emptyState.action {
        ADEGlassActionButton(title: label, symbol: "play.circle", tint: ADEColor.accent) {
          ADEHaptics.light()
          store.perform(action, label: label)
        }
        .disabled(!store.canInvoke || store.isInFlight(action))
      }
    }
  }
}

// MARK: - Markers and shared bits

/// What a component this build cannot draw looks like.
///
/// Compact and in place, per the degradation ladder: the surrounding panel is
/// intact and only this node is missing, so the marker says which component
/// without claiming anything is broken.
struct PluginUnsupportedNodeMarker: View {
  let node: PluginVocabNode

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "square.dashed")
        .font(.system(size: 10, weight: .semibold))
      Text(label)
        .font(.caption2.weight(.medium))
    }
    .foregroundStyle(ADEColor.textMuted)
    .padding(.horizontal, 9)
    .padding(.vertical, 6)
    .background(ADEColor.surfaceBackground.opacity(0.4), in: Capsule())
    .overlay(Capsule().strokeBorder(ADEColor.border.opacity(0.3), style: StrokeStyle(lineWidth: 0.5, dash: [3, 3])))
    .accessibilityLabel(label)
  }

  private var label: String {
    switch node {
    case let .invalid(name, _):
      return "\(name) — this plugin sent something unusable"
    default:
      return "\(node.componentName) — not shown on iPhone"
    }
  }
}

struct PluginInlineEmptyText: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.caption)
      .foregroundStyle(ADEColor.textMuted)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 6)
  }
}

/// The manifest icon namespace, and the phone's half of it.
///
/// A plugin manifest names an icon with a TOKEN — `beer`, `git-branch`,
/// `list-checks` — drawn from one shared list that every client resolves in its
/// own catalogue. Desktop resolves it against `PLUGIN_ICONS` in
/// `apps/desktop/src/renderer/components/plugins/pluginIcons.tsx` and draws a
/// Phosphor glyph; this map is the same list resolved into SF Symbols.
///
/// Before this map, iOS had no token namespace at all: it passed the manifest
/// string straight to `UIImage(systemName:)`, so a token drew only if it
/// happened to also be an SF Symbol name. Thirty-three of the shared tokens
/// silently became the puzzle piece, and the ones that did draw could mean
/// something else entirely — the alpha test found the sharpest form of it, where
/// a drink plugin's `beer` read as a cup of tea on the phone and a stein on the
/// desktop beside it, from one manifest.
///
/// Two rules follow, and both are load-bearing:
///
/// - **Every token in desktop's list has an entry here.** A parity test walks a
///   literal copy of that list in both directions, so neither side can add a
///   token the other cannot draw.
/// - **The token list is the whole namespace.** An unrecognised string is not
///   retried as an SF Symbol name — see ``symbol(_:)``.
///
/// The pairs are chosen for what a glyph MEANS rather than what it is called:
/// Phosphor's `Robot` and SF's `cpu` share no word and the same idea.
///
/// ## The second kind: brand tokens
///
/// Phosphor and SF Symbols are both *idea* catalogues, and a plugin that carries
/// a real brand has no idea to point at. `ade-cursor-cloud` is Cursor, and asking
/// it to pick between `cloud` and `robot` produced a pane, a menu row and a chat
/// header that all drew a generic cloud beside the word "Cursor" — the plugin
/// looked unfinished in exactly the places its identity mattered most.
///
/// So the namespace has a second, smaller, equally CLOSED half: `brand:<vendor>`
/// tokens that resolve to the provider-logo assets this app already ships for
/// its own runtimes. Closed for the same reason the first half is — a token that
/// draws on one client and puzzles on the other is one manifest with two
/// pictures — and small because a token only earns a place when BOTH clients
/// already carry that vendor's mark. `brand:linear` is deliberately absent: no
/// asset exists on either side, and inventing one here would break parity in the
/// direction that is hardest to notice.
///
/// A brand token is an IMAGE, not a symbol name, which is why ``symbol(_:)``
/// keeps returning nil for one and callers reach for ``image(_:fallback:)`` or
/// ``glyph(_:fallback:pointSize:weight:)`` instead. An unknown `brand:*` string
/// degrades to the very same puzzle piece an unknown ordinary token does — the
/// prefix buys no leniency, because a raw asset name passed through would be the
/// removed `UIImage(systemName:)` passthrough all over again.
enum PluginSymbol {
  /// Manifest icon token → SF Symbol. Mirrors desktop's `PLUGIN_ICONS`.
  ///
  /// Same additive/removal rule as desktop: adding a token is safe, removing
  /// one silently changes the appearance of a plugin already shipped with it.
  ///
  /// Where the two catalogues do not have the same glyph, the entry picks the
  /// nearest MEANING and the comment says what was given up. A token with no
  /// honest neighbour would be left out rather than pointed at something that
  /// reads as another thing — that mistake is exactly what `beer` was.
  private static let tokens: [String: String] = [
    "beer": "mug",
    "bell": "bell",
    "bookmark": "bookmark",
    "brain": "brain",
    "bug": "ladybug",
    "calendar": "calendar",
    "chart": "chart.line.uptrend.xyaxis",
    "chart-bar": "chart.bar",
    "chat": "bubble.left.and.bubble.right",
    "clock": "clock",
    "clock-counter-clockwise": "clock.arrow.circlepath",
    "cloud": "cloud",
    "code": "chevron.left.forwardslash.chevron.right",
    // Phosphor's compass rose. SF's nearest rose is Safari's; `location.north`
    // is the needle without the dial, which reads as "heading" rather than
    // "explore", so the dial wins.
    "compass": "safari",
    "cube": "cube",
    "currency": "dollarsign.circle",
    "database": "cylinder.split.1x2",
    "desktop": "desktopcomputer",
    "device-mobile": "iphone",
    "envelope": "envelope",
    "eye": "eye",
    "file": "doc.text",
    "flag": "flag",
    "folder": "folder",
    "gear": "gearshape",
    "git-branch": "arrow.triangle.branch",
    // A commit is a node on a line, and SF has no VCS glyph at all. The filled
    // dot inside a ring is the closest reading; it loses the line.
    "git-commit": "smallcircle.filled.circle",
    "git-pull-request": "arrow.triangle.pull",
    "globe": "globe",
    "graph": "point.3.connected.trianglepath.dotted",
    "heart": "heart",
    "image": "photo",
    "kanban": "rectangle.split.3x1",
    "key": "key",
    "lightning": "bolt",
    "link": "link",
    "list": "checklist",
    "list-checks": "checklist",
    "lock": "lock",
    "magic": "wand.and.stars",
    "microphone": "mic",
    "music": "music.note",
    "note": "note.text",
    "package": "shippingbox",
    "palette": "paintpalette",
    "play": "play",
    "plug": "powerplug",
    "puzzle": "puzzlepiece.extension",
    // SF has no robot. `cpu` is the machine-that-acts reading Phosphor's Robot
    // carries in a plugin manifest, and it is not mistakable for anything else
    // in this list.
    "robot": "cpu",
    // Nor a rocket. Launch/ship is the sense, and `paperplane` is the only
    // send-it glyph in the catalogue; it loses the "big release" weight.
    "rocket": "paperplane",
    "rows": "rectangle.split.1x2",
    "shield": "checkmark.shield",
    "sparkle": "sparkles",
    "star": "star",
    "storefront": "storefront",
    "table": "tablecells",
    "tag": "tag",
    "terminal": "terminal",
    "timer": "timer",
    "toolbox": "wrench.and.screwdriver",
    "trend": "chart.line.uptrend.xyaxis",
    "users": "person.3",
    "video": "video",
    "wrench": "wrench.adjustable",
  ]

  /// Manifest brand token → asset catalogue name. Mirrors desktop's brand half
  /// of `PLUGIN_ICONS`.
  ///
  /// Every entry here is a mark the app ALREADY ships for its own runtimes and
  /// providers (see `providerAssetName(_:)`), so adding one costs nothing at
  /// build time and, more importantly, cannot introduce a vendor whose logo the
  /// desktop cannot draw. A vendor with an asset on only one client does not
  /// belong in this map at all — that is the single rule the list is closed to
  /// enforce.
  ///
  /// Same additive/removal rule as the symbol map above: adding a token is safe,
  /// removing one silently changes the appearance of a plugin already shipped
  /// with it.
  private static let brandTokens: [String: String] = [
    "brand:claude": "ProviderClaude",
    "brand:codex": "ProviderCodex",
    "brand:cursor": "ProviderCursor",
    "brand:github": "ProviderGitHub",
    "brand:openai": "ProviderOpenAI",
  ]

  /// Every token this build maps, of either kind, for the parity test that
  /// walks the shared list. The two kinds are also exposed separately below,
  /// because "does this resolve to a real SF Symbol" is a question only the
  /// symbol half can be asked — a brand token resolves to an asset and would
  /// fail that check while being perfectly correct.
  static var tokenNames: [String] { (Array(tokens.keys) + Array(brandTokens.keys)).sorted() }

  /// The symbol half only: tokens that must name a glyph in this OS catalogue.
  static var symbolTokenNames: [String] { tokens.keys.sorted() }

  /// The brand half only: tokens that must name an image in this bundle.
  static var brandTokenNames: [String] { brandTokens.keys.sorted() }

  static func exists(_ name: String) -> Bool {
    UIImage(systemName: name) != nil
  }

  /// Whether this bundle actually carries the named asset. The brand half's
  /// equivalent of ``exists(_:)``: a map entry naming an imageset that was never
  /// added draws an empty box beside a label, which reads as the plugin's fault.
  static func assetExists(_ name: String) -> Bool {
    UIImage(named: name) != nil
  }

  /// The SF Symbol a manifest icon draws as, or nil when nothing honest draws.
  ///
  /// **The token list IS the cross-client namespace, and this lookup is the
  /// whole of it.** A known token draws its mapped symbol; anything else draws
  /// nothing here and the caller falls back to the puzzle piece. There is
  /// deliberately no second attempt at `UIImage(systemName:)` on the raw string.
  ///
  /// That fallback existed and was removed on purpose. It looked like
  /// compatibility for an author who had named an SF Symbol directly, but such a
  /// name never *worked* in any sense the author could rely on: it rendered on
  /// this client and drew a puzzle piece on desktop, which cannot resolve SF
  /// Symbol names at all. Keeping it would have meant the phone silently
  /// accepting icons no other client can draw — one manifest, two pictures,
  /// which is the exact bug class the retrospective recorded. With the map
  /// authoritative, an icon that renders anywhere renders everywhere, and an
  /// unrecognised string puzzles identically on both.
  static func symbol(_ name: String?) -> String? {
    guard let raw = normalized(name) else { return nil }
    return tokens[raw]
  }

  static func resolve(_ name: String?, fallback: String) -> String {
    symbol(name) ?? fallback
  }

  /// The asset a `brand:` token draws as, or nil for everything else.
  ///
  /// Nil for an unknown `brand:*` string as much as for an ordinary token —
  /// there is no "strip the prefix and try the asset catalogue" branch, on
  /// purpose. Such a branch would let a manifest name any imageset this app
  /// happens to bundle, which renders here and puzzles on desktop: the exact
  /// asymmetry the removed `UIImage(systemName:)` passthrough created and the
  /// reason ``symbol(_:)`` refuses raw SF Symbol names.
  static func brandAsset(_ name: String?) -> String? {
    guard let raw = normalized(name) else { return nil }
    return brandTokens[raw]
  }

  /// Whether this build draws anything at all for a token, of either kind. For
  /// the call sites that render nothing rather than a puzzle piece when a row
  /// names no usable icon — a menu row without an image is ordinary on iOS,
  /// where a stamped-on generic mark is not.
  static func drawsIcon(_ name: String?) -> Bool {
    symbol(name) != nil || brandAsset(name) != nil
  }

  /// The icon for a `Label`'s image slot: the vendor's mark for a brand token,
  /// the mapped SF Symbol for an ordinary one, and `fallback` for anything the
  /// list does not know.
  ///
  /// `Label(_:systemImage:)` cannot express the first case at all — it takes a
  /// symbol NAME — which is why the plugin call sites use the two-closure
  /// `Label { Text(…) } icon: { … }` form instead. The brand image is left at
  /// its intrinsic size (the provider assets are 24pt vectors) and marked
  /// `.original` so the vendor's own colours survive: a system menu tints a
  /// template image to the row's foreground colour, which would flatten the
  /// Claude and Codex marks to a monochrome smear.
  static func image(_ name: String?, fallback: String) -> Image {
    if let asset = brandAsset(name) {
      return Image(asset).renderingMode(.original)
    }
    return Image(systemName: resolve(name, fallback: fallback))
  }

  /// The same icon for a standalone slot that has already chosen a point size —
  /// a toolbar glyph, the mark inside an action pill.
  ///
  /// A symbol takes the size through `.font`, the way the call sites always
  /// did. An asset cannot: `Image(asset)` is a fixed 24pt vector and `.font`
  /// does nothing to it, so an 11pt pill would be built around a 24pt logo.
  /// Making it resizable and framing it to the same point size is what keeps a
  /// brand token from resizing the control it sits in.
  @ViewBuilder
  static func glyph(
    _ name: String?,
    fallback: String,
    pointSize: CGFloat,
    weight: Font.Weight = .semibold
  ) -> some View {
    if let asset = brandAsset(name) {
      Image(asset)
        .renderingMode(.original)
        .resizable()
        .scaledToFit()
        .frame(width: pointSize, height: pointSize)
    } else {
      Image(systemName: resolve(name, fallback: fallback))
        .font(.system(size: pointSize, weight: weight))
    }
  }

  /// Trimmed and lowercased, or nil when the author wrote nothing. Case and
  /// stray whitespace are the author's, not a different icon — shared by both
  /// lookups so the two halves cannot disagree about what "the same token" is.
  private static func normalized(_ name: String?) -> String? {
    guard let raw = name?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
      return nil
    }
    return raw.lowercased()
  }
}
