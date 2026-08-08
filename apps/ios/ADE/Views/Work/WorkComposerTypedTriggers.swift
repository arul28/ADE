import SwiftUI
import UIKit

// MARK: - Smart links

private func workSmartLinkPathParts(_ components: URLComponents) -> [String] {
  components.path.split(separator: "/").map(String.init)
}

private func workSmartLinkLinearIdentifier(_ components: URLComponents) -> String? {
  let parts = workSmartLinkPathParts(components)
  guard let issueIndex = parts.firstIndex(where: { $0.caseInsensitiveCompare("issue") == .orderedSame }),
        parts.indices.contains(issueIndex + 1)
  else { return nil }
  let identifier = parts[issueIndex + 1].uppercased()
  guard identifier.range(of: "^[A-Z][A-Z0-9]+-[0-9]+$", options: .regularExpression) != nil else {
    return nil
  }
  return identifier
}

private func workSmartLinkIsAsciiNumber(_ value: String) -> Bool {
  !value.isEmpty && value.unicodeScalars.allSatisfy { $0.value >= 48 && $0.value <= 57 }
}

struct WorkSmartLink: Equatable {
  enum Provider: Equatable {
    case github
    case linear
    case ade
    case web
  }

  let url: String
  let range: NSRange
  let provider: Provider

  var compactLabel: String {
    guard let components = URLComponents(string: url) else { return url }
    let parts = workSmartLinkPathParts(components)
    switch provider {
    case .github:
      guard parts.count >= 2 else { return url }
      let repo = parts[1].lowercased().hasSuffix(".git") ? String(parts[1].dropLast(4)) : parts[1]
      let repoLabel = "\(parts[0])/\(repo)"
      let section = parts.indices.contains(2) ? parts[2].lowercased() : ""
      if parts.count >= 4,
         (section == "pull" || section == "issues"),
         workSmartLinkIsAsciiNumber(parts[3]) {
        return "\(repoLabel)#\(parts[3])"
      }
      if parts.count >= 4, section == "commit" { return "\(repoLabel)@\(parts[3].prefix(7))" }
      if parts.count >= 5, section == "actions", parts[3].lowercased() == "runs" {
        return "\(repoLabel) · run \(parts[4])"
      }
      return repoLabel
    case .linear:
      return workSmartLinkLinearIdentifier(components) ?? url
    case .ade:
      let target = ([components.host].compactMap { $0 } + parts).joined(separator: "/")
      return target.isEmpty ? "ADE link" : "ADE · \(target)"
    case .web:
      return url
    }
  }
}

enum WorkSmartLinkDetector {
  private static let regex = try! NSRegularExpression(
    pattern: "(?:https?://|ade://)[^\\s<>\\\"'`]+",
    options: [.caseInsensitive]
  )
  private static let trailingPunctuation = CharacterSet(charactersIn: ".,;:!?")
  private static let balancedTrailingCharacters: [Character: Character] = [")": "(", "]": "[", "}": "{"]

  private static func trimmedRange(_ initialRange: NSRange, in text: NSString) -> NSRange {
    var range = initialRange
    while range.length > 0 {
      let final = text.substring(with: NSRange(location: NSMaxRange(range) - 1, length: 1))
      if final.unicodeScalars.allSatisfy({ trailingPunctuation.contains($0) }) {
        range.length -= 1
        continue
      }
      guard let close = final.first,
            let open = balancedTrailingCharacters[close]
      else { break }
      let candidate = text.substring(with: range)
      let opens = candidate.filter { $0 == open }.count
      let closes = candidate.filter { $0 == close }.count
      guard closes > opens else { break }
      range.length -= 1
    }
    return range
  }

  static func links(in text: NSString) -> [WorkSmartLink] {
    let fullRange = NSRange(location: 0, length: text.length)
    return regex.matches(in: text as String, range: fullRange).compactMap { match in
      let range = trimmedRange(match.range, in: text)
      guard range.length > 0 else { return nil }
      let url = text.substring(with: range)
      guard let components = URLComponents(string: url),
            let scheme = components.scheme?.lowercased(),
            scheme == "ade" || ((scheme == "http" || scheme == "https") && components.host?.isEmpty == false)
      else { return nil }
      let host = components.host?.lowercased()
      let provider: WorkSmartLink.Provider
      if scheme == "ade" {
        provider = .ade
      } else if host == "github.com" {
        provider = .github
      } else if host == "linear.app", workSmartLinkLinearIdentifier(components) != nil {
        provider = .linear
      } else {
        provider = .web
      }
      return WorkSmartLink(url: url, range: range, provider: provider)
    }
  }

  static func atomicDeletionRange(in text: NSString, range: NSRange, replacementText: String) -> NSRange? {
    guard replacementText.isEmpty, range.length > 0 else { return nil }
    let intersected = links(in: text).filter { NSIntersectionRange($0.range, range).length > 0 }
    guard !intersected.isEmpty else { return nil }
    if range.length == 1, let link = intersected.first { return link.range }
    let start = intersected.reduce(range.location) { min($0, $1.range.location) }
    let end = intersected.reduce(NSMaxRange(range)) { max($0, NSMaxRange($1.range)) }
    return NSRange(location: start, length: end - start)
  }
}

// MARK: - Trigger detection

/// The two typed triggers the composer recognizes, matching the shared
/// desktop/TUI semantics: `/` opens the slash-command list, `@` opens file
/// quick-open. Detection runs on the text *before* the cursor so a trigger can
/// live anywhere in the draft ("fix @src/foo.ts then run /test").
enum WorkComposerTriggerKind: Equatable {
  case slash
  case at
}

/// A live trigger resolved from the draft: which kind, the query typed after the
/// trigger char, and the UTF-16 range (trigger char through cursor) that a
/// committed suggestion replaces.
struct WorkComposerTriggerMatch: Equatable {
  let kind: WorkComposerTriggerKind
  let query: String
  /// Range of the trigger span in the full text, in UTF-16 units so it lines up
  /// with `UITextView.selectedRange`.
  let range: NSRange
}

/// Pure, cursor-relative trigger detection shared by the composer text view.
/// Mirrors the desktop/TUI regexes exactly:
///   slash — `(?:^|\s)/([^\s/]*)$`
///   at    — `(?:^|\s)@([^\s@]*)$`
/// applied to the substring before the cursor. When both match (rare), the one
/// whose trigger char sits closest to the cursor wins.
enum WorkComposerTriggerDetector {
  private static let slashRegex = try! NSRegularExpression(pattern: "(?:^|\\s)/([^\\s/]*)$")
  private static let atRegex = try! NSRegularExpression(pattern: "(?:^|\\s)@([^\\s@]*)$")

  static func detect(in text: NSString, cursor: Int) -> WorkComposerTriggerMatch? {
    guard cursor >= 0, cursor <= text.length else { return nil }
    let prefix = text.substring(to: cursor) as NSString
    let searchRange = NSRange(location: 0, length: prefix.length)

    func consider(_ regex: NSRegularExpression, _ kind: WorkComposerTriggerKind) -> WorkComposerTriggerMatch? {
      guard let match = regex.firstMatch(in: prefix as String, range: searchRange) else { return nil }
      let group = match.range(at: 1)
      guard group.location != NSNotFound else { return nil }
      // The trigger char (`/` or `@`) sits immediately before the capture group.
      let triggerCharLocation = group.location - 1
      guard triggerCharLocation >= 0 else { return nil }
      let query = prefix.substring(with: group)
      let span = NSRange(location: triggerCharLocation, length: cursor - triggerCharLocation)
      return WorkComposerTriggerMatch(kind: kind, query: query, range: span)
    }

    let slash = consider(slashRegex, .slash)
    let at = consider(atRegex, .at)

    switch (slash, at) {
    case let (s?, a?):
      return s.range.location >= a.range.location ? s : a
    case let (s?, nil):
      return s
    case let (nil, a?):
      return a
    default:
      return nil
    }
  }
}

// MARK: - Suggestion model

/// One row in the inline suggestion strip. `insertText` is the canonical token
/// *without* the trailing space (the space is appended on commit).
struct WorkComposerSuggestion: Identifiable, Equatable {
  let id: String
  let kind: WorkComposerTriggerKind
  let title: String
  let subtitle: String?
  let insertText: String
}

/// Curated per-provider slash commands, ported from the retired
/// `WorkSlashCommandsSheet`. iOS keeps a tight, recognizable set per provider;
/// the desktop registry is richer but not yet exposed to mobile over sync.
enum WorkComposerSlashCatalog {
  static func commands(provider: String) -> [(command: String, description: String)] {
    switch provider.lowercased() {
    case "claude":
      return [
        ("/clear", "Drop prior context and start fresh."),
        ("/compact", "Summarize the transcript so far."),
        ("/plan", "Ask the assistant to draft a plan."),
        ("/review", "Review the current diff."),
      ]
    case "codex":
      return [
        ("/explain", "Explain a file or change."),
        ("/refactor", "Propose a refactor."),
        ("/tests", "Write or run tests."),
        ("/review", "Review code or a diff."),
      ]
    case "opencode":
      return [
        ("/plan", "Ask the model for a plan before acting."),
        ("/explain", "Explain a file or change."),
        ("/review", "Review the current diff."),
      ]
    case "pi":
      return [
        ("/compact", "Compact the native Pi session context."),
        ("/explain", "Explain a file or change."),
        ("/review", "Review the current diff."),
      ]
    default:
      return [
        ("/help", "Show available commands."),
        ("/explain", "Explain a file or change."),
      ]
    }
  }

  static func suggestions(provider: String, query: String) -> [WorkComposerSuggestion] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return commands(provider: provider)
      .filter { trimmed.isEmpty || $0.command.dropFirst().lowercased().hasPrefix(trimmed) }
      .map {
        WorkComposerSuggestion(
          id: "slash:\($0.command)",
          kind: .slash,
          title: $0.command,
          subtitle: $0.description,
          insertText: $0.command
        )
      }
  }
}

/// Drives the inline suggestion strip: consumes trigger matches from the text
/// view, resolves suggestions (curated slash list locally, file quick-open over
/// sync), and hands committed selections back to the text view for splicing.
///
/// Visibility is derived purely from `activeMatch` — never from focus — so it
/// avoids the repo's "expansion state from @FocusState" bug class.
@MainActor
final class WorkComposerSuggestionController: ObservableObject {
  @Published private(set) var activeMatch: WorkComposerTriggerMatch?
  @Published private(set) var suggestions: [WorkComposerSuggestion] = []
  @Published private(set) var isLoading = false

  var provider: String = ""
  var laneId: String? {
    didSet {
      // The cached workspace belongs to the previous lane; a stale entry
      // would make @ quick-open search the wrong worktree. The generation
      // bump plus cancel also invalidates the in-flight fetch, whose
      // post-await writes could otherwise restore the old lane's workspace
      // id, re-populate the cache, and publish old-lane rows.
      if oldValue != laneId {
        laneGeneration += 1
        fetchTask?.cancel()
        fetchTask = nil
        cachedWorkspaceId = nil
        fileCache.removeAll()
        fileCacheOrder.removeAll()
        if let match = activeMatch, match.kind == .at {
          // An @ trigger typed against the previous lane re-fetches against
          // the new one instead of keeping the superseded results.
          scheduleFileFetch(query: match.query)
        } else if isLoading {
          isLoading = false
        }
      }
    }
  }
  weak var syncService: SyncService?

  /// Wired by the text view: performs the splice on the live UITextView so
  /// first-responder state and selection survive the insertion.
  var onCommit: ((WorkComposerSuggestion, NSRange) -> Void)?

  private var fetchTask: Task<Void, Never>?
  private var cachedWorkspaceId: String?
  /// Bumped on every lane change; every post-await write in a fetch compares
  /// its captured value so a superseded task cannot touch the new lane's state.
  private var laneGeneration = 0

  /// Per-lane quick-open results keyed by lowercased query (`""` is the browse
  /// list). Backspacing through a path is the common case on mobile and every
  /// prefix has already been fetched, so this turns a sync round-trip per
  /// keystroke into one per *new* query. Entries expire so a long-lived
  /// composer can't pin a stale listing after files change on the host.
  private var fileCache: [String: (items: [WorkComposerSuggestion], at: Date)] = [:]
  private var fileCacheOrder: [String] = []
  private static let fileCacheTTL: TimeInterval = 30
  private static let fileCacheMaxEntries = 32

  private func cachedFiles(_ key: String) -> [WorkComposerSuggestion]? {
    guard let entry = fileCache[key] else { return nil }
    guard Date().timeIntervalSince(entry.at) < Self.fileCacheTTL else {
      fileCache.removeValue(forKey: key)
      fileCacheOrder.removeAll { $0 == key }
      return nil
    }
    return entry.items
  }

  private func rememberFiles(_ key: String, _ items: [WorkComposerSuggestion]) {
    if fileCache[key] == nil { fileCacheOrder.append(key) }
    fileCache[key] = (items, Date())
    while fileCacheOrder.count > Self.fileCacheMaxEntries {
      let oldest = fileCacheOrder.removeFirst()
      fileCache.removeValue(forKey: oldest)
    }
  }

  var isVisible: Bool {
    activeMatch != nil && (isLoading || !suggestions.isEmpty)
  }

  func update(match: WorkComposerTriggerMatch?) {
    guard let match else {
      clear()
      return
    }
    // Ignore a no-op re-detection of the same span+query to avoid re-fetching
    // on cursor-only movements that don't change the trigger.
    if let current = activeMatch, current == match { return }
    activeMatch = match

    switch match.kind {
    case .slash:
      fetchTask?.cancel()
      isLoading = false
      suggestions = WorkComposerSlashCatalog.suggestions(provider: provider, query: match.query)
    case .at:
      scheduleFileFetch(query: match.query)
    }
  }

  func commit(_ suggestion: WorkComposerSuggestion) {
    guard let match = activeMatch else { return }
    onCommit?(suggestion, match.range)
    clear()
  }

  func clear() {
    fetchTask?.cancel()
    fetchTask = nil
    if activeMatch != nil { activeMatch = nil }
    if !suggestions.isEmpty { suggestions = [] }
    if isLoading { isLoading = false }
  }

  private func scheduleFileFetch(query: String) {
    fetchTask?.cancel()
    let cacheKey = query.lowercased()
    if let cached = cachedFiles(cacheKey) {
      fetchTask = nil
      isLoading = false
      finishFiles(cached)
      return
    }
    isLoading = true
    let laneId = laneId
    let sync = syncService
    let generation = laneGeneration
    fetchTask = Task { [weak self] in
      // Small debounce so rapid typing doesn't spawn a fetch per keystroke.
      try? await Task.sleep(nanoseconds: 40_000_000)
      guard !Task.isCancelled else { return }
      guard let self, let sync, let laneId, !laneId.isEmpty else {
        await MainActor.run { self?.finishFiles([]) }
        return
      }
      do {
        let workspaceId = try await self.resolveWorkspaceId(
          laneId: laneId,
          sync: sync,
          generation: generation
        )
        guard !Task.isCancelled, self.laneGeneration == generation, let workspaceId else {
          await MainActor.run {
            guard self.laneGeneration == generation else { return }
            self.finishFiles([])
          }
          return
        }
        let items = try await sync.quickOpen(
          workspaceId: workspaceId,
          query: query,
          limit: 20,
          includeIgnored: true
        )
        guard !Task.isCancelled, self.laneGeneration == generation else { return }
        let mapped = items.map { item -> WorkComposerSuggestion in
          let name = (item.path as NSString).lastPathComponent
          let dir = (item.path as NSString).deletingLastPathComponent
          return WorkComposerSuggestion(
            id: "file:\(item.path)",
            kind: .at,
            title: name.isEmpty ? item.path : name,
            subtitle: dir.isEmpty ? nil : dir,
            insertText: "@\(item.path)"
          )
        }
        await MainActor.run {
          guard self.laneGeneration == generation else { return }
          // Only successful fetches are cached — caching the `[]` from a failed
          // round-trip would pin an empty list for the whole TTL.
          self.rememberFiles(cacheKey, mapped)
          self.finishFiles(mapped)
        }
      } catch {
        guard !Task.isCancelled else { return }
        await MainActor.run {
          guard self.laneGeneration == generation else { return }
          self.finishFiles([])
        }
      }
    }
  }

  private func finishFiles(_ items: [WorkComposerSuggestion]) {
    // Only apply while an `@` trigger is still active — a later slash/no trigger
    // may have superseded this fetch.
    guard activeMatch?.kind == .at else { return }
    isLoading = false
    suggestions = items
  }

  private func resolveWorkspaceId(
    laneId: String,
    sync: SyncService,
    generation: Int
  ) async throws -> String? {
    if let cachedWorkspaceId { return cachedWorkspaceId }
    let workspaces = try await sync.listWorkspaces()
    let resolved = workFilesWorkspace(for: laneId, in: workspaces)?.id
    // A lane change during the await means this id belongs to the old lane:
    // return it un-cached so the new lane's fetch resolves its own workspace.
    if let resolved, laneGeneration == generation { cachedWorkspaceId = resolved }
    return resolved
  }
}

// MARK: - Chip styling

extension NSAttributedString.Key {
  /// Marks a run as a committed chip token; carries the pill tint the layout
  /// manager draws behind it.
  static let workComposerChipTint = NSAttributedString.Key("workComposerChipTint")
}

/// Draws a rounded, tinted pill behind any run bearing `.workComposerChipTint`,
/// giving `/command` and `@path` tokens a distinct chip treatment inline with
/// the editable text.
final class WorkComposerChipLayoutManager: NSLayoutManager {
  override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
    super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
    guard let textStorage else { return }
    let charRange = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
    textStorage.enumerateAttribute(.workComposerChipTint, in: charRange, options: []) { value, range, _ in
      guard let color = value as? UIColor else { return }
      let glyphRange = self.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
      guard let container = textContainer(forGlyphAt: glyphRange.location, effectiveRange: nil) else { return }
      enumerateEnclosingRects(
        forGlyphRange: glyphRange,
        withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0),
        in: container
      ) { rect, _ in
        let pill = rect.insetBy(dx: -4, dy: -1).offsetBy(dx: origin.x, dy: origin.y)
        let path = UIBezierPath(roundedRect: pill, cornerRadius: 6)
        color.withAlphaComponent(0.16).setFill()
        path.fill()
      }
    }
  }
}

// MARK: - Composer text view

final class WorkComposerPastingTextView: UITextView {
  var onPasteImages: (([UIImage]) -> Bool)?

  private var pastedImages: [UIImage] {
    let images = UIPasteboard.general.images ?? []
    if !images.isEmpty { return Array(images.prefix(workChatInputAttachmentLimit + 1)) }
    if let image = UIPasteboard.general.image { return [image] }
    return []
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(paste(_:)),
       onPasteImages != nil,
       UIPasteboard.general.hasImages {
      return true
    }
    return super.canPerformAction(action, withSender: sender)
  }

  override func paste(_ sender: Any?) {
    let images = pastedImages
    if !images.isEmpty,
       onPasteImages?(images) == true {
      return
    }
    super.paste(sender)
  }
}

@MainActor
private final class WorkSmartLinkContextMenuController: NSObject, UIContextMenuInteractionDelegate {
  weak var textView: UITextView?
  var onRemove: ((WorkSmartLink) -> Void)?

  init(textView: UITextView, onRemove: @escaping (WorkSmartLink) -> Void) {
    self.textView = textView
    self.onRemove = onRemove
    super.init()
    textView.addInteraction(UIContextMenuInteraction(delegate: self))
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard let textView,
          let link = link(at: location, in: textView)
    else { return nil }
    return UIContextMenuConfiguration(identifier: link.url as NSString, previewProvider: nil) { [weak self] _ in
      let copy = UIAction(title: "Copy link", image: UIImage(systemName: "doc.on.doc")) { _ in
        UIPasteboard.general.string = link.url
      }
      let remove = UIAction(title: "Remove link", image: UIImage(systemName: "trash"), attributes: .destructive) { _ in
        self?.onRemove?(link)
      }
      return UIMenu(children: [copy, remove])
    }
  }

  private func link(at point: CGPoint, in textView: UITextView) -> WorkSmartLink? {
    let adjusted = CGPoint(
      x: point.x + textView.contentOffset.x - textView.textContainerInset.left,
      y: point.y + textView.contentOffset.y - textView.textContainerInset.top
    )
    let glyph = textView.layoutManager.glyphIndex(for: adjusted, in: textView.textContainer)
    guard glyph < textView.layoutManager.numberOfGlyphs else { return nil }
    let hitRect = textView.layoutManager
      .boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: textView.textContainer)
      .insetBy(dx: -6, dy: -6)
    guard hitRect.contains(adjusted) else { return nil }
    let character = textView.layoutManager.characterIndexForGlyph(at: glyph)
    return WorkSmartLinkDetector.links(in: textView.text as NSString).first { NSLocationInRange(character, $0.range) }
  }
}

/// UIKit responder changes can synchronously re-enter SwiftUI's view graph.
/// Always apply the latest focus request after the current representable update
/// has yielded so send-time draft mutations cannot create an AttributeGraph
/// dependency cycle.
@MainActor
private final class WorkComposerFocusScheduler {
  private var lastRequest: Bool?
  private var pendingTask: Task<Void, Never>?

  @discardableResult
  func apply(_ isFocused: Bool, to textView: UITextView) -> Task<Void, Never>? {
    // SwiftUI may update the representable more than once for the same state.
    // Keep the queued transition instead of canceling it without a replacement.
    if lastRequest == isFocused, pendingTask != nil { return pendingTask }

    let previousRequest = lastRequest
    lastRequest = isFocused
    pendingTask?.cancel()
    pendingTask = nil

    // Preserve the existing initial-false behavior: creating a composer with
    // an unfocused binding must not dismiss a responder owned by another view.
    guard isFocused || previousRequest == true else { return nil }

    // When UIKit already matches the latest binding and no transition remains
    // queued, there is nothing to defer. This keeps routine SwiftUI updates
    // from creating main-actor tasks after focus has settled.
    guard textView.isFirstResponder != isFocused else { return nil }

    pendingTask = Task { @MainActor [weak self, weak textView] in
      await Task.yield()
      guard !Task.isCancelled,
            let self,
            let textView,
            self.lastRequest == isFocused
      else { return }

      self.pendingTask = nil
      if isFocused {
        if !textView.isFirstResponder {
          textView.becomeFirstResponder()
        }
      } else if textView.isFirstResponder {
        textView.resignFirstResponder()
      }
    }
    return pendingTask
  }
}

/// Plain UITextView composer for start-chat surfaces that do not need typed
/// trigger chips but still need multiline sizing and image-paste interception.
struct WorkPlainComposerTextView: UIViewRepresentable {
  @Binding var text: String
  @Binding var isFocused: Bool
  @Binding var measuredHeight: CGFloat
  let placeholder: String
  var acceptsPastedImages = true
  var onPasteImages: (([UIImage]) -> Void)? = nil

  private var maxHeight: CGFloat {
    ceil(UIFont.preferredFont(forTextStyle: .body).lineHeight * 6) + 8
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(self)
  }

  func makeUIView(context: Context) -> UITextView {
    let textStorage = NSTextStorage()
    let layoutManager = WorkComposerChipLayoutManager()
    textStorage.addLayoutManager(layoutManager)
    let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
    container.widthTracksTextView = true
    container.lineFragmentPadding = 0
    layoutManager.addTextContainer(container)
    let textView = WorkComposerPastingTextView(frame: .zero, textContainer: container)
    context.coordinator.textStorage = textStorage
    context.coordinator.layoutManager = layoutManager
    textView.delegate = context.coordinator
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.isScrollEnabled = false
    textView.font = UIFont.preferredFont(forTextStyle: .body)
    textView.adjustsFontForContentSizeCategory = true
    textView.textColor = UIColor(ADEColor.textPrimary)
    textView.tintColor = UIColor(ADEColor.accent)
    textView.autocorrectionType = .yes
    textView.autocapitalizationType = .sentences
    textView.spellCheckingType = .yes
    textView.smartQuotesType = .no
    textView.smartDashesType = .no
    textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    textView.setContentHuggingPriority(.defaultLow, for: .horizontal)
    textView.accessibilityIdentifier = "Work.StartChat.Composer.TextView"
    textView.accessibilityHint = "Long press a link for copy and remove actions."
    textView.onPasteImages = acceptsPastedImages
      ? { [weak coordinator = context.coordinator] images in
          coordinator?.handlePasteImages(images) ?? false
        }
      : nil

    context.coordinator.textView = textView
    context.coordinator.installSmartLinkMenu(on: textView)
    context.coordinator.applyPlaceholder(placeholder)
    if !text.isEmpty { textView.text = text }
    context.coordinator.restyleSmartLinks()
    context.coordinator.updatePlaceholderVisibility()
    context.coordinator.updateHeight()
    return textView
  }

  func updateUIView(_ textView: UITextView, context: Context) {
    context.coordinator.parent = self
    if let textView = textView as? WorkComposerPastingTextView {
      textView.onPasteImages = acceptsPastedImages
        ? { [weak coordinator = context.coordinator] images in
            coordinator?.handlePasteImages(images) ?? false
          }
        : nil
    }
    if textView.text != text {
      textView.text = text
      context.coordinator.restyleSmartLinks()
      context.coordinator.updatePlaceholderVisibility()
    }
    context.coordinator.applyPlaceholder(placeholder)
    context.coordinator.applyFocusRequest(isFocused, to: textView)
    context.coordinator.updateHeight()
  }

  @MainActor
  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: WorkPlainComposerTextView
    weak var textView: UITextView?
    var textStorage: NSTextStorage?
    var layoutManager: WorkComposerChipLayoutManager?
    private var smartLinkMenu: WorkSmartLinkContextMenuController?
    private var placeholderLabel: UILabel?
    private let focusScheduler = WorkComposerFocusScheduler()

    init(_ parent: WorkPlainComposerTextView) {
      self.parent = parent
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
      if !parent.isFocused { parent.isFocused = true }
    }

    func textViewDidEndEditing(_ textView: UITextView) {
      if parent.isFocused { parent.isFocused = false }
    }

    func textViewDidChange(_ textView: UITextView) {
      if parent.text != textView.text {
        parent.text = textView.text
      }
      if textView.markedTextRange == nil { restyleSmartLinks() }
      updatePlaceholderVisibility()
      updateHeight()
    }

    func textView(
      _ textView: UITextView,
      shouldChangeTextIn range: NSRange,
      replacementText text: String
    ) -> Bool {
      guard let deletionRange = WorkSmartLinkDetector.atomicDeletionRange(
        in: textView.text as NSString,
        range: range,
        replacementText: text
      ) else { return true }
      remove(range: deletionRange)
      return false
    }

    func textView(
      _ textView: UITextView,
      shouldInteractWith URL: URL,
      in characterRange: NSRange,
      interaction: UITextItemInteraction
    ) -> Bool {
      false
    }

    func installSmartLinkMenu(on textView: UITextView) {
      smartLinkMenu = WorkSmartLinkContextMenuController(textView: textView) { [weak self] link in
        self?.remove(range: link.range)
      }
    }

    func restyleSmartLinks() {
      guard let textView else { return }
      let storage = textView.textStorage
      let fullRange = NSRange(location: 0, length: storage.length)
      let baseAttributes: [NSAttributedString.Key: Any] = [
        .font: UIFont.preferredFont(forTextStyle: .body),
        .foregroundColor: UIColor(ADEColor.textPrimary),
      ]
      textView.typingAttributes = baseAttributes
      guard fullRange.length > 0 else { return }
      let tint = UIColor(ADEColor.accent)
      storage.beginEditing()
      storage.setAttributes(baseAttributes, range: fullRange)
      for link in WorkSmartLinkDetector.links(in: storage.string as NSString) {
        storage.addAttributes([
          .font: UIFont.preferredFont(forTextStyle: .body).withWeight(.semibold),
          .foregroundColor: tint,
          .workComposerChipTint: tint,
          .link: link.url,
        ], range: link.range)
      }
      storage.endEditing()
    }

    private func remove(range: NSRange) {
      guard let textView, NSMaxRange(range) <= (textView.text as NSString).length else { return }
      textView.textStorage.replaceCharacters(in: range, with: "")
      textView.selectedRange = NSRange(location: min(range.location, textView.textStorage.length), length: 0)
      if parent.text != textView.text { parent.text = textView.text }
      restyleSmartLinks()
      updatePlaceholderVisibility()
      updateHeight()
    }

    @discardableResult
    func applyFocusRequest(_ isFocused: Bool, to textView: UITextView) -> Task<Void, Never>? {
      focusScheduler.apply(isFocused, to: textView)
    }

    func handlePasteImages(_ images: [UIImage]) -> Bool {
      guard parent.acceptsPastedImages,
            let onPasteImages = parent.onPasteImages,
            !images.isEmpty
      else { return false }
      onPasteImages(images)
      return true
    }

    func applyPlaceholder(_ text: String) {
      guard let textView else { return }
      if placeholderLabel == nil {
        let label = UILabel()
        label.numberOfLines = 0
        label.font = UIFont.preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = UIColor(ADEColor.textMuted)
        label.translatesAutoresizingMaskIntoConstraints = false
        textView.addSubview(label)
        NSLayoutConstraint.activate([
          label.leadingAnchor.constraint(equalTo: textView.leadingAnchor),
          label.trailingAnchor.constraint(lessThanOrEqualTo: textView.trailingAnchor),
          label.topAnchor.constraint(equalTo: textView.topAnchor),
        ])
        placeholderLabel = label
      }
      placeholderLabel?.text = text
      updatePlaceholderVisibility()
    }

    func updatePlaceholderVisibility() {
      placeholderLabel?.isHidden = !(textView?.text.isEmpty ?? true)
    }

    func updateHeight() {
      guard let textView else { return }
      let width = textView.bounds.width
      guard width > 0 else { return }
      let fitting = textView.sizeThatFits(CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)).height
      let clamped = min(max(fitting, parent.minHeight), parent.maxHeight)
      textView.isScrollEnabled = fitting > parent.maxHeight
      if abs(parent.measuredHeight - clamped) > 0.5 {
        DispatchQueue.main.async { [weak self] in
          self?.parent.measuredHeight = clamped
        }
      }
    }
  }

  var minHeight: CGFloat { 28 }
}

/// UITextView-backed composer input. SwiftUI's `TextField` exposes neither the
/// cursor position (needed for cursor-relative trigger detection) nor inline
/// styled runs (needed for chips), so the composer drops to UIKit here while
/// keeping `draftState.text` as the plain-text source of truth that gets sent.
struct WorkComposerTextView: UIViewRepresentable {
  @ObservedObject var draftState: WorkChatComposerDraftState
  @ObservedObject var controller: WorkComposerSuggestionController
  let canCompose: Bool
  let placeholder: String
  @Binding var measuredHeight: CGFloat
  var acceptsPastedImages = true
  var onPasteImages: (([UIImage]) -> Void)? = nil
  var maxLines = 6

  private var maxHeight: CGFloat {
    ceil(UIFont.preferredFont(forTextStyle: .body).lineHeight * CGFloat(max(1, maxLines))) + 8
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(self)
  }

  func makeUIView(context: Context) -> UITextView {
    // Explicit TextKit 1 stack so our custom layout manager (chip backgrounds)
    // is guaranteed to be the one in use.
    let textStorage = NSTextStorage()
    let layoutManager = WorkComposerChipLayoutManager()
    textStorage.addLayoutManager(layoutManager)
    let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
    container.widthTracksTextView = true
    container.lineFragmentPadding = 0
    layoutManager.addTextContainer(container)

    let textView = WorkComposerPastingTextView(frame: .zero, textContainer: container)
    // UITextView retains only the text container of a manually-built TextKit 1
    // stack; keep the storage + layout manager alive on the coordinator or the
    // stack deallocates out from under the view.
    context.coordinator.textStorage = textStorage
    context.coordinator.layoutManager = layoutManager
    textView.delegate = context.coordinator
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.isScrollEnabled = false
    // Keep natural-language prompt traits aligned with `adePromptInputTraits()`.
    textView.autocorrectionType = .yes
    textView.autocapitalizationType = .sentences
    textView.spellCheckingType = .yes
    textView.smartQuotesType = .no
    textView.smartDashesType = .no
    textView.tintColor = UIColor(ADEColor.accent)
    textView.adjustsFontForContentSizeCategory = true
    textView.typingAttributes = context.coordinator.baseAttributes
    textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    textView.setContentHuggingPriority(.defaultLow, for: .horizontal)
    textView.accessibilityIdentifier = "Work.Chat.Composer.TextView"
    textView.accessibilityHint = "Long press a link for copy and remove actions."
    textView.onPasteImages = acceptsPastedImages
      ? { [weak coordinator = context.coordinator] images in
          coordinator?.handlePasteImages(images) ?? false
        }
      : nil

    context.coordinator.textView = textView
    context.coordinator.installSmartLinkMenu(on: textView)
    // Route committed suggestions straight to the live text view.
    controller.onCommit = { [weak coordinator = context.coordinator] suggestion, range in
      coordinator?.commit(suggestion, replacing: range)
    }

    if !draftState.text.isEmpty {
      context.coordinator.setText(draftState.text, resetChips: true)
    }
    context.coordinator.applyPlaceholder(placeholder)
    context.coordinator.applyFocusRequest(draftState.isFocused, to: textView)
    context.coordinator.updateHeight()
    return textView
  }

  func updateUIView(_ textView: UITextView, context: Context) {
    context.coordinator.parent = self
    textView.isEditable = canCompose
    if let textView = textView as? WorkComposerPastingTextView {
      textView.onPasteImages = acceptsPastedImages
        ? { [weak coordinator = context.coordinator] images in
            coordinator?.handlePasteImages(images) ?? false
          }
        : nil
    }
    context.coordinator.applyPlaceholder(placeholder)

    // Reflect external mutations to the source of truth (dictation insert,
    // send-clear, restore-unsent) that didn't originate from this text view.
    if draftState.text != textView.text {
      context.coordinator.setText(draftState.text, resetChips: false)
    }
    context.coordinator.applyFocusRequest(draftState.isFocused, to: textView)
    context.coordinator.updateHeight()
  }

  @MainActor
  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: WorkComposerTextView
    weak var textView: UITextView?
    // Strong owners of the manual TextKit 1 stack (see makeUIView).
    var textStorage: NSTextStorage?
    var layoutManager: WorkComposerChipLayoutManager?
    /// Committed chip spans, kept in sync with edits so we know which runs to
    /// keep styled and which to de-chip when they're edited into.
    private var chips: [(range: NSRange, text: String)] = []
    private var placeholderLabel: UILabel?
    private var triggerInputTraitsActive = false
    private let focusScheduler = WorkComposerFocusScheduler()
    private var smartLinkMenu: WorkSmartLinkContextMenuController?

    init(_ parent: WorkComposerTextView) {
      self.parent = parent
    }

    var baseAttributes: [NSAttributedString.Key: Any] {
      [
        .font: UIFont.preferredFont(forTextStyle: .body),
        .foregroundColor: UIColor(ADEColor.textPrimary),
      ]
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
      if !parent.draftState.isFocused { parent.draftState.isFocused = true }
    }

    func textViewDidEndEditing(_ textView: UITextView) {
      if parent.draftState.isFocused { parent.draftState.isFocused = false }
    }

    @discardableResult
    func applyFocusRequest(_ isFocused: Bool, to textView: UITextView) -> Task<Void, Never>? {
      focusScheduler.apply(isFocused, to: textView)
    }

    private func chipAttributes(kind: WorkComposerTriggerKind) -> [NSAttributedString.Key: Any] {
      let tint = UIColor(ADEColor.providerChatAccent(for: parent.controller.provider))
      let font: UIFont
      switch kind {
      case .slash:
        let body = UIFont.preferredFont(forTextStyle: .body)
        font = UIFont.monospacedSystemFont(ofSize: body.pointSize - 1, weight: .semibold)
      case .at:
        font = UIFont.preferredFont(forTextStyle: .body).withWeight(.semibold)
      }
      return [
        .font: font,
        .foregroundColor: tint,
        .workComposerChipTint: tint,
      ]
    }

    private var smartLinkAttributes: [NSAttributedString.Key: Any] {
      let tint = UIColor(ADEColor.accent)
      return [
        .font: UIFont.preferredFont(forTextStyle: .body).withWeight(.semibold),
        .foregroundColor: tint,
        .workComposerChipTint: tint,
      ]
    }

    private func applyPromptInputTraits(protectingTrigger: Bool) {
      guard let textView else { return }
      guard triggerInputTraitsActive != protectingTrigger else { return }
      triggerInputTraitsActive = protectingTrigger

      textView.autocorrectionType = protectingTrigger ? .no : .yes
      textView.autocapitalizationType = protectingTrigger ? .none : .sentences
      textView.spellCheckingType = protectingTrigger ? .no : .yes
      if textView.isFirstResponder {
        textView.reloadInputViews()
      }
    }

    // MARK: Text sync

    func setText(_ text: String, resetChips: Bool) {
      guard let textView else { return }
      if resetChips {
        chips = []
      } else {
        chips = revalidatedChips(against: text as NSString)
      }
      let selection = textView.selectedRange
      textView.text = text
      restyle()
      let clamped = min(selection.location, (text as NSString).length)
      textView.selectedRange = NSRange(location: clamped, length: 0)
      textView.typingAttributes = baseAttributes
      updatePlaceholderVisibility()
      detectTrigger()
    }

    /// Keep only chips whose exact substring still lives at the same offset —
    /// enough to preserve chips through appends (dictation) while dropping any
    /// invalidated by a clear/prepend.
    private func revalidatedChips(against text: NSString) -> [(range: NSRange, text: String)] {
      chips.filter { chip in
        chip.range.location + chip.range.length <= text.length
          && text.substring(with: chip.range) == chip.text
      }
    }

    // MARK: Delegate

    func textView(
      _ textView: UITextView,
      shouldChangeTextIn range: NSRange,
      replacementText text: String
    ) -> Bool {
      if let deletionRange = WorkSmartLinkDetector.atomicDeletionRange(
        in: textView.text as NSString,
        range: range,
        replacementText: text
      ) {
        remove(range: deletionRange)
        return false
      }
      let delta = (text as NSString).length - range.length
      let editStart = range.location
      let editEnd = range.location + range.length
      var next: [(range: NSRange, text: String)] = []
      for chip in chips {
        let cStart = chip.range.location
        let cEnd = chip.range.location + chip.range.length
        if range.length > 0, NSIntersectionRange(chip.range, range).length > 0 {
          continue  // deletion/replacement touches the chip -> de-chip it
        }
        if range.length == 0, editStart > cStart, editStart < cEnd {
          continue  // insertion inside the chip -> de-chip it
        }
        if editEnd <= cStart {
          next.append((NSRange(location: cStart + delta, length: chip.range.length), chip.text))
        } else if editStart >= cEnd {
          next.append(chip)
        } else if range.length == 0, editStart == cStart {
          next.append((NSRange(location: cStart + delta, length: chip.range.length), chip.text))
        } else {
          next.append(chip)
        }
      }
      chips = next
      return true
    }

    func installSmartLinkMenu(on textView: UITextView) {
      smartLinkMenu = WorkSmartLinkContextMenuController(textView: textView) { [weak self] link in
        self?.remove(range: link.range)
      }
    }

    func textView(
      _ textView: UITextView,
      shouldInteractWith URL: URL,
      in characterRange: NSRange,
      interaction: UITextItemInteraction
    ) -> Bool {
      false
    }

    func textViewDidChange(_ textView: UITextView) {
      if parent.draftState.text != textView.text {
        parent.draftState.text = textView.text
      }
      // Skip restyle AND trigger detection while marked text (IME/multistage
      // input) is active: uncommitted composition can transiently contain
      // `/`/`@` and must not pop the suggestion strip. Detection re-runs on
      // the post-commit didChange/didChangeSelection callbacks.
      if textView.markedTextRange == nil {
        restyle()
      }
      updatePlaceholderVisibility()
      updateHeight()
      if textView.markedTextRange == nil {
        detectTrigger()
      }
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
      if textView.markedTextRange == nil {
        detectTrigger()
      }
    }

    func handlePasteImages(_ images: [UIImage]) -> Bool {
      guard parent.acceptsPastedImages,
            let onPasteImages = parent.onPasteImages,
            !images.isEmpty else { return false }
      onPasteImages(images)
      parent.controller.clear()
      return true
    }

    // MARK: Detection + commit

    private func detectTrigger() {
      guard let textView else { return }
      guard textView.isFirstResponder else {
        applyPromptInputTraits(protectingTrigger: false)
        parent.controller.clear()
        return
      }
      let selection = textView.selectedRange
      // Only detect against a collapsed caret; a ranged selection isn't a trigger.
      guard selection.length == 0 else {
        applyPromptInputTraits(protectingTrigger: false)
        parent.controller.clear()
        return
      }
      let match = WorkComposerTriggerDetector.detect(
        in: textView.text as NSString,
        cursor: selection.location
      )
      applyPromptInputTraits(protectingTrigger: match != nil)
      parent.controller.update(match: match)
    }

    func commit(_ suggestion: WorkComposerSuggestion, replacing range: NSRange) {
      guard let textView else { return }
      let full = textView.text as NSString
      guard range.location + range.length <= full.length else { return }
      let chipText = suggestion.insertText
      let insertion = chipText + " "

      // Shift any chips after the replaced span by the length delta, and drop
      // any that overlapped the trigger span.
      let delta = (insertion as NSString).length - range.length
      let editEnd = range.location + range.length
      var next: [(range: NSRange, text: String)] = []
      for chip in chips {
        if NSIntersectionRange(chip.range, range).length > 0 { continue }
        if chip.range.location >= editEnd {
          next.append((NSRange(location: chip.range.location + delta, length: chip.range.length), chip.text))
        } else {
          next.append(chip)
        }
      }
      let chipRange = NSRange(location: range.location, length: (chipText as NSString).length)
      next.append((chipRange, chipText))
      chips = next

      let storage = textView.textStorage
      storage.replaceCharacters(in: range, with: insertion)
      restyle()

      let caret = range.location + (insertion as NSString).length
      textView.selectedRange = NSRange(location: caret, length: 0)
      textView.typingAttributes = baseAttributes

      if parent.draftState.text != textView.text {
        parent.draftState.text = textView.text
      }
      updatePlaceholderVisibility()
      updateHeight()
    }

    // MARK: Styling

    private func restyle() {
      guard let textView else { return }
      let storage = textView.textStorage
      let fullRange = NSRange(location: 0, length: storage.length)
      guard fullRange.length > 0 else { return }
      storage.beginEditing()
      storage.setAttributes(baseAttributes, range: fullRange)
      for chip in chips where chip.range.location + chip.range.length <= storage.length {
        // Resolve each chip's kind from its leading trigger char so slash and
        // file chips can style differently.
        let kind: WorkComposerTriggerKind = chip.text.hasPrefix("/") ? .slash : .at
        storage.addAttributes(chipAttributes(kind: kind), range: chip.range)
      }
      for link in WorkSmartLinkDetector.links(in: storage.string as NSString) {
        var attributes = smartLinkAttributes
        attributes[.link] = link.url
        storage.addAttributes(attributes, range: link.range)
      }
      storage.endEditing()
    }

    private func remove(range: NSRange) {
      guard let textView, NSMaxRange(range) <= (textView.text as NSString).length else { return }
      chips = chips.compactMap { chip in
        if NSIntersectionRange(chip.range, range).length > 0 { return nil }
        if chip.range.location >= NSMaxRange(range) {
          return (NSRange(location: chip.range.location - range.length, length: chip.range.length), chip.text)
        }
        return chip
      }
      textView.textStorage.replaceCharacters(in: range, with: "")
      textView.selectedRange = NSRange(location: min(range.location, textView.textStorage.length), length: 0)
      textView.typingAttributes = baseAttributes
      if parent.draftState.text != textView.text { parent.draftState.text = textView.text }
      restyle()
      updatePlaceholderVisibility()
      updateHeight()
      detectTrigger()
    }

    // MARK: Placeholder + height

    func applyPlaceholder(_ text: String) {
      guard let textView else { return }
      if placeholderLabel == nil {
        let label = UILabel()
        label.numberOfLines = 0
        label.font = UIFont.preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = UIColor(ADEColor.textMuted)
        label.translatesAutoresizingMaskIntoConstraints = false
        textView.addSubview(label)
        NSLayoutConstraint.activate([
          label.leadingAnchor.constraint(equalTo: textView.leadingAnchor),
          label.trailingAnchor.constraint(lessThanOrEqualTo: textView.trailingAnchor),
          label.topAnchor.constraint(equalTo: textView.topAnchor),
        ])
        placeholderLabel = label
      }
      placeholderLabel?.text = text
      updatePlaceholderVisibility()
    }

    private func updatePlaceholderVisibility() {
      placeholderLabel?.isHidden = !(textView?.text.isEmpty ?? true)
    }

    func updateHeight() {
      guard let textView else { return }
      let width = textView.bounds.width
      guard width > 0 else { return }
      let fitting = textView.sizeThatFits(CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)).height
      let clamped = min(max(fitting, parent.minHeight), parent.maxHeight)
      textView.isScrollEnabled = fitting > parent.maxHeight
      if abs(parent.measuredHeight - clamped) > 0.5 {
        DispatchQueue.main.async { [weak self] in
          self?.parent.measuredHeight = clamped
        }
      }
    }
  }

  var minHeight: CGFloat { 24 }
}

private extension UIFont {
  func withWeight(_ weight: UIFont.Weight) -> UIFont {
    let descriptor = fontDescriptor.addingAttributes([
      .traits: [UIFontDescriptor.TraitKey.weight: weight]
    ])
    return UIFont(descriptor: descriptor, size: pointSize)
  }
}

// MARK: - Inline suggestion strip

/// Compact suggestion strip pinned directly above the composer text field. Rows
/// are filtered by the live query; tapping one splices a styled chip into the
/// draft. Visibility follows the controller's trigger state, not focus.
struct WorkComposerSuggestionStrip: View {
  @ObservedObject var controller: WorkComposerSuggestionController

  var body: some View {
    if controller.isVisible {
      VStack(alignment: .leading, spacing: 0) {
        header
        if controller.isLoading && controller.suggestions.isEmpty {
          loadingRow
        } else {
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
              ForEach(controller.suggestions) { suggestion in
                Button {
                  controller.commit(suggestion)
                } label: {
                  row(suggestion)
                }
                .buttonStyle(.plain)
              }
            }
          }
          .frame(maxHeight: 176)
        }
      }
      .background(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(.ultraThinMaterial)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.75)
      )
      .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      .transition(.opacity.combined(with: .move(edge: .bottom)))
      .accessibilityIdentifier("Work.Chat.Composer.SuggestionStrip")
    }
  }

  private var header: some View {
    HStack(spacing: 6) {
      Image(systemName: controller.activeMatch?.kind == .at ? "doc.text" : "command")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(controller.activeMatch?.kind == .at ? "Files" : "Commands")
        .font(.caption2.weight(.bold))
        .tracking(0.6)
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 0)
      if controller.isLoading {
        ProgressView().controlSize(.mini)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }

  private var loadingRow: some View {
    HStack(spacing: 8) {
      ProgressView().controlSize(.mini)
      Text("Searching files…")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.bottom, 10)
  }

  private func row(_ suggestion: WorkComposerSuggestion) -> some View {
    HStack(spacing: 10) {
      Image(systemName: suggestion.kind == .at ? "doc" : "chevron.right.circle")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(ADEColor.providerChatAccent(for: controller.provider))
        .frame(width: 18)
      VStack(alignment: .leading, spacing: 1) {
        Text(suggestion.title)
          .font(suggestion.kind == .slash
            ? .footnote.weight(.semibold).monospaced()
            : .footnote.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(suggestion.kind == .at ? .middle : .tail)
        if let subtitle = suggestion.subtitle, !subtitle.isEmpty {
          Text(subtitle)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .contentShape(Rectangle())
  }
}
