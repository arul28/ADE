import SwiftUI
import UIKit

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
      // would make @ quick-open search the wrong worktree.
      if oldValue != laneId { cachedWorkspaceId = nil }
    }
  }
  weak var syncService: SyncService?

  /// Wired by the text view: performs the splice on the live UITextView so
  /// first-responder state and selection survive the insertion.
  var onCommit: ((WorkComposerSuggestion, NSRange) -> Void)?

  private var fetchTask: Task<Void, Never>?
  private var cachedWorkspaceId: String?

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
    isLoading = true
    let laneId = laneId
    let sync = syncService
    fetchTask = Task { [weak self] in
      // Small debounce so rapid typing doesn't spawn a fetch per keystroke.
      try? await Task.sleep(nanoseconds: 40_000_000)
      guard !Task.isCancelled else { return }
      guard let self, let sync, let laneId, !laneId.isEmpty else {
        await MainActor.run { self?.finishFiles([]) }
        return
      }
      do {
        let workspaceId = try await self.resolveWorkspaceId(laneId: laneId, sync: sync)
        guard !Task.isCancelled, let workspaceId else {
          await MainActor.run { self.finishFiles([]) }
          return
        }
        let items = try await sync.quickOpen(
          workspaceId: workspaceId,
          query: query,
          limit: 20,
          includeIgnored: true
        )
        guard !Task.isCancelled else { return }
        await MainActor.run {
          self.finishFiles(
            items.map { item in
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
          )
        }
      } catch {
        guard !Task.isCancelled else { return }
        await MainActor.run { self.finishFiles([]) }
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

  private func resolveWorkspaceId(laneId: String, sync: SyncService) async throws -> String? {
    if let cachedWorkspaceId { return cachedWorkspaceId }
    let workspaces = try await sync.listWorkspaces()
    let resolved = workFilesWorkspace(for: laneId, in: workspaces)?.id
    if let resolved { cachedWorkspaceId = resolved }
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

  private var maxHeight: CGFloat {
    ceil(UIFont.preferredFont(forTextStyle: .body).lineHeight * 6) + 8
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

    let textView = UITextView(frame: .zero, textContainer: container)
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
    textView.typingAttributes = context.coordinator.baseAttributes
    textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    textView.setContentHuggingPriority(.defaultLow, for: .horizontal)
    textView.accessibilityIdentifier = "Work.Chat.Composer.TextView"

    context.coordinator.textView = textView
    // Route committed suggestions straight to the live text view.
    controller.onCommit = { [weak coordinator = context.coordinator] suggestion, range in
      coordinator?.commit(suggestion, replacing: range)
    }

    if !draftState.text.isEmpty {
      context.coordinator.setText(draftState.text, resetChips: true)
    }
    context.coordinator.applyPlaceholder(placeholder)
    context.coordinator.updateHeight()
    return textView
  }

  func updateUIView(_ textView: UITextView, context: Context) {
    context.coordinator.parent = self
    textView.isEditable = canCompose
    context.coordinator.applyPlaceholder(placeholder)

    // Reflect external mutations to the source of truth (dictation insert,
    // send-clear, restore-unsent) that didn't originate from this text view.
    if draftState.text != textView.text {
      context.coordinator.setText(draftState.text, resetChips: false)
    }
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

    init(_ parent: WorkComposerTextView) {
      self.parent = parent
    }

    var baseAttributes: [NSAttributedString.Key: Any] {
      [
        .font: UIFont.preferredFont(forTextStyle: .body),
        .foregroundColor: UIColor(ADEColor.textPrimary),
      ]
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

    // MARK: Detection + commit

    private func detectTrigger() {
      guard let textView else { return }
      guard textView.isFirstResponder else {
        parent.controller.clear()
        return
      }
      let selection = textView.selectedRange
      // Only detect against a collapsed caret; a ranged selection isn't a trigger.
      guard selection.length == 0 else {
        parent.controller.clear()
        return
      }
      let match = WorkComposerTriggerDetector.detect(
        in: textView.text as NSString,
        cursor: selection.location
      )
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
      storage.endEditing()
    }

    // MARK: Placeholder + height

    func applyPlaceholder(_ text: String) {
      guard let textView else { return }
      if placeholderLabel == nil {
        let label = UILabel()
        label.numberOfLines = 0
        label.font = UIFont.preferredFont(forTextStyle: .body)
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
