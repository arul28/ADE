import SwiftUI

// MARK: - Thread card

struct PrReviewThreadCard: View {
  let thread: PrReviewThread
  let isLive: Bool
  let isFocused: Bool
  @Binding var replyDraft: String
  let onFocus: () -> Void
  let onReply: (String) -> Void
  let onResolve: (Bool) -> Void

  @State private var showReplyField = false

  private var firstComment: PrReviewThreadComment? { thread.comments.first }

  private var authorLogin: String { firstComment?.author ?? "unknown" }

  private var botProvider: PrBotProvider? { prBotProvider(from: authorLogin) }

  private var avatarLetter: String {
    if let botProvider { return prBotLetter(botProvider) }
    guard let first = authorLogin.first else { return "?" }
    return String(first).uppercased()
  }

  private var avatarTint: Color {
    botProvider != nil ? ADEColor.tintPRs : ADEColor.accent
  }

  private var displayName: String {
    if let botProvider { return prBotDisplayName(botProvider) }
    return authorLogin
  }

  private var lineLabel: String? {
    if let line = thread.line ?? thread.originalLine {
      return "L\(line)"
    }
    return nil
  }

  private var ago: String {
    prRelativeTime(thread.updatedAt ?? thread.createdAt ?? firstComment?.createdAt)
  }

  private var suggestion: PrReviewSuggestion? {
    guard let body = firstComment?.body else { return nil }
    return PrReviewSuggestion.extract(from: body)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .center, spacing: 9) {
        threadAvatar
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 5) {
            Text(displayName)
              .font(.subheadline.weight(.bold))
              .foregroundStyle(ADEColor.textPrimary)
            if botProvider != nil {
              PrTagChip(label: "bot", color: ADEColor.tintPRs)
            }
            Spacer(minLength: 0)
          }
          HStack(spacing: 0) {
            if let path = thread.path {
              Text(path)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
            }
            if let line = lineLabel {
              Text(" · ")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(ADEColor.textMuted)
              Text(line)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(ADEColor.tintPRs)
            }
            Text(" · \(ago)")
              .font(.system(size: 10, design: .monospaced))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        if !thread.isResolved {
          PrTagChip(label: "unresolved", color: ADEColor.warning)
        }
      }
      .padding(.horizontal, 14)
      .padding(.top, 12)
      .padding(.bottom, 8)

      VStack(alignment: .leading, spacing: 10) {
        if let body = firstComment?.body, !body.isEmpty {
          let stripped = PrReviewSuggestion.stripSuggestion(from: body)
          if !stripped.isEmpty {
            PrInlineCodeText(text: stripped)
          }
        }

        if let suggestion {
          PrDiffPreview(lines: suggestion.diffLines(startLine: thread.line ?? thread.originalLine))
        }

        // Subsequent replies (collapsed behind "N more replies" affordance)
        if thread.comments.count > 1 {
          PrThreadRepliesSection(comments: Array(thread.comments.dropFirst()))
        }

        HStack(spacing: 6) {
          if suggestion != nil {
            ThreadButton(label: "Apply suggestion", isProminent: true, isEnabled: isLive) {
              onFocus()
              onReply("✅ applying suggestion")
            }
          }
          ThreadButton(label: "Reply", isEnabled: true) {
            onFocus()
            withAnimation(.snappy) { showReplyField = true }
          }
          ThreadButton(label: thread.isResolved ? "Reopen" : "Resolve", isEnabled: isLive) {
            onResolve(!thread.isResolved)
          }
          Spacer(minLength: 0)
        }

        if showReplyField {
          VStack(alignment: .trailing, spacing: 6) {
            TextEditor(text: $replyDraft)
              .frame(minHeight: 70)
              .adeInsetField(cornerRadius: 10, padding: 8)
              .font(.footnote)
            HStack(spacing: 8) {
              Button("Cancel") {
                withAnimation(.snappy) { showReplyField = false }
                replyDraft = ""
              }
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)

              Button("Send") {
                let trimmed = replyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return }
                onReply(trimmed)
                withAnimation(.snappy) { showReplyField = false }
              }
              .buttonStyle(.borderedProminent)
              .tint(ADEColor.tintPRs)
              .controlSize(.small)
              .disabled(!isLive || replyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
          }
        }
      }
      .padding(.horizontal, 14)
      .padding(.bottom, 12)
    }
    .prGlassCard(
      cornerRadius: 18,
      tint: isFocused ? ADEColor.accent : nil,
      strokeOpacity: isFocused ? 0.45 : 0.10
    )
  }

  private var threadAvatar: some View {
    ZStack {
      Circle().fill(avatarTint.opacity(0.2))
      Circle().strokeBorder(avatarTint.opacity(0.35), lineWidth: 0.5)
      Text(avatarLetter)
        .font(.system(size: 11, weight: .heavy))
        .foregroundStyle(avatarTint)
    }
    .frame(width: 26, height: 26)
  }
}

// MARK: - Thread replies (collapsed)

private struct PrThreadRepliesSection: View {
  let comments: [PrReviewThreadComment]
  @State private var expanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) { expanded.toggle() }
      } label: {
        HStack(spacing: 6) {
          Image(systemName: expanded ? "chevron.up" : "chevron.down")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
          Text(expanded ? "Hide replies" : "\(comments.count) repl\(comments.count == 1 ? "y" : "ies")")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
          Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)

      if expanded {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(Array(comments.enumerated()), id: \.offset) { _, comment in
            if let body = comment.body, !body.isEmpty {
              PrThreadReplyBubble(comment: comment)
            }
          }
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .padding(.top, 4)
  }
}

private struct PrThreadReplyBubble: View {
  let comment: PrReviewThreadComment

  private var avatarLetter: String {
    guard let first = comment.author.first else { return "?" }
    return String(first).uppercased()
  }

  private var ago: String { prRelativeTime(comment.createdAt) }

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      ZStack {
        Circle().fill(ADEColor.accent.opacity(0.16))
        Circle().strokeBorder(ADEColor.accent.opacity(0.3), lineWidth: 0.5)
        Text(avatarLetter)
          .font(.system(size: 9, weight: .heavy))
          .foregroundStyle(ADEColor.accent)
      }
      .frame(width: 20, height: 20)

      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 5) {
          Text(comment.author)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(ago)
            .font(.system(size: 9, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
        }
        Text(comment.body ?? "")
          .font(.system(size: 11))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
          .lineLimit(8)
      }
    }
    .padding(.horizontal, 2)
  }
}

private struct ThreadButton: View {
  let label: String
  var isProminent: Bool = false
  let isEnabled: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(label)
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
          isProminent ? ADEColor.tintPRs.opacity(0.14) : Color.white.opacity(0.04),
          in: RoundedRectangle(cornerRadius: 8, style: .continuous)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(
              isProminent ? ADEColor.tintPRs.opacity(0.3) : ADEColor.glassBorder,
              lineWidth: 0.5
            )
        )
        .foregroundStyle(isProminent ? ADEColor.tintPRs : ADEColor.textSecondary)
    }
    .buttonStyle(.plain)
    .disabled(!isEnabled)
    .opacity(isEnabled ? 1 : 0.5)
  }
}

/// Plain text with backtick spans rendered as tinted mono code. The parsed
/// `AttributedString` is cached (keyed by the raw text) so repeated body
/// evaluations of thread/comment rows don't re-scan the string on the main
/// thread — that parse showed up directly in scroll hitches.
struct PrInlineCodeText: View {
  let text: String

  var body: some View {
    Text(Self.attributed(for: text))
      .font(.system(.footnote))
      .foregroundStyle(ADEColor.textPrimary)
      .multilineTextAlignment(.leading)
      .fixedSize(horizontal: false, vertical: true)
  }

  static func attributed(for text: String) -> AttributedString {
    // Namespaced key: the shared cache is also used by the full-markdown
    // renderer, and both key by content — an unprefixed key would let the two
    // renderings clobber each other for identical source strings.
    let cacheKey = "inline:\(text)"
    if let cached = PrMarkdownRenderingCache.shared.attributedString(for: cacheKey) {
      return cached
    }
    let rendered = render(text)
    PrMarkdownRenderingCache.shared.store(rendered, for: cacheKey)
    return rendered
  }

  private static func render(_ text: String) -> AttributedString {
    var result = AttributedString("")
    var cursor = text.startIndex
    while cursor < text.endIndex {
      if let range = text.range(of: "`", range: cursor..<text.endIndex),
         let closing = text.range(of: "`", range: range.upperBound..<text.endIndex) {
        if range.lowerBound > cursor {
          result.append(AttributedString(String(text[cursor..<range.lowerBound])))
        }
        var code = AttributedString(String(text[range.upperBound..<closing.lowerBound]))
        code.font = .system(.footnote, design: .monospaced)
        code.foregroundColor = ADEColor.tintPRs
        result.append(code)
        cursor = closing.upperBound
      } else {
        result.append(AttributedString(String(text[cursor..<text.endIndex])))
        break
      }
    }
    return result
  }
}

// MARK: - Collapsible resolved section

struct PrCollapsibleResolvedSection: View {
  let threads: [PrReviewThread]
  let isLive: Bool
  let onReopen: (String) -> Void

  @State private var expanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text("RESOLVED")
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
            .tracking(1.2)
            .foregroundColor(ADEColor.textSecondary)
          Spacer(minLength: 12)
          Text("\(threads.count) resolved")
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
            .foregroundColor(ADEColor.textMuted)
          Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .rotationEffect(.degrees(expanded ? 90 : 0))
            .animation(.easeInOut(duration: 0.18), value: expanded)
        }
        .padding(.horizontal, 4)
        .padding(.top, 4)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)

      if expanded {
        VStack(spacing: 0) {
          ForEach(Array(threads.enumerated()), id: \.1.id) { index, thread in
            if index > 0 {
              Divider().overlay(ADEColor.glassBorder)
            }
            PrResolvedThreadRow(
              thread: thread,
              isLive: isLive,
              onReopen: { onReopen(thread.id) }
            )
          }
        }
        .prGlassCard(cornerRadius: 18)
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
  }
}

// MARK: - Resolved thread row

private struct PrResolvedThreadRow: View {
  let thread: PrReviewThread
  let isLive: Bool
  let onReopen: () -> Void

  private var firstComment: PrReviewThreadComment? { thread.comments.first }
  private var login: String { firstComment?.author ?? "unknown" }
  private var botProvider: PrBotProvider? { prBotProvider(from: login) }

  private var displayName: String {
    if let botProvider { return prBotDisplayName(botProvider) }
    return login
  }

  private var avatarLetter: String {
    if let botProvider { return prBotLetter(botProvider) }
    guard let first = login.first else { return "?" }
    return String(first).uppercased()
  }

  private var avatarTint: Color {
    botProvider != nil ? ADEColor.tintPRs : ADEColor.accent
  }

  var body: some View {
    HStack(spacing: 10) {
      ZStack {
        Circle().fill(avatarTint.opacity(0.2))
        Circle().strokeBorder(avatarTint.opacity(0.35), lineWidth: 0.5)
        Text(avatarLetter)
          .font(.system(size: 11, weight: .heavy))
          .foregroundStyle(avatarTint)
      }
      .frame(width: 26, height: 26)

      VStack(alignment: .leading, spacing: 2) {
        Text(displayName)
          .font(.footnote.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        HStack(spacing: 0) {
          if let path = thread.path {
            Text(path).font(.system(size: 10, design: .monospaced))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
          if let line = thread.line ?? thread.originalLine {
            Text(" · L\(line)").font(.system(size: 10, design: .monospaced))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
      }
      Spacer(minLength: 8)
      Button("Reopen") { onReopen() }
        .buttonStyle(.plain)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(ADEColor.glassBorder, lineWidth: 0.5)
        )
        .disabled(!isLive)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }
}

// MARK: - Reply composer

struct PrReplyComposer: View {
  @Binding var text: String
  let placeholder: String
  let isLive: Bool
  let onSend: () -> Void
  let onClearFocus: (() -> Void)?

  var body: some View {
    HStack(spacing: 8) {
      if let onClearFocus {
        Button {
          onClearFocus()
        } label: {
          Image(systemName: "xmark.circle.fill")
            .font(.system(size: 15))
            .foregroundStyle(ADEColor.textMuted)
        }
        .buttonStyle(.plain)
      }

      ZStack(alignment: .leading) {
        if text.isEmpty {
          Text(placeholder)
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
        }
        TextField("", text: $text, axis: .vertical)
          .font(.system(size: 12, design: .monospaced))
          .lineLimit(1...4)
          .foregroundStyle(ADEColor.textPrimary)
      }

      Button(action: onSend) {
        Image(systemName: "paperplane.fill")
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(Color.white)
          .frame(width: 30, height: 30)
          .background(ADEColor.accentDeep, in: Circle())
      }
      .buttonStyle(.plain)
      .disabled(!isLive || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      .opacity((!isLive || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) ? 0.5 : 1)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .prGlassCard(cornerRadius: 22)
  }
}

// MARK: - Timeline display items (desktop `PrTimeline` folding parity)

/// Timeline event folded for display. Runs of 2+ consecutive commits by the
/// same author collapse into a single group row so long push sessions don't
/// dominate the thread (mirrors desktop `buildRenderItems`).
enum PrTimelineDisplayItem: Identifiable, Equatable {
  case event(PrTimelineEvent)
  case commitGroup(id: String, author: String?, events: [PrTimelineEvent])

  var id: String {
    switch self {
    case .event(let event): return event.id
    case .commitGroup(let id, _, _): return id
    }
  }
}

func buildPrTimelineDisplayItems(_ events: [PrTimelineEvent]) -> [PrTimelineDisplayItem] {
  var items: [PrTimelineDisplayItem] = []
  var pendingCommits: [PrTimelineEvent] = []

  func flushCommits() {
    guard !pendingCommits.isEmpty else { return }
    if pendingCommits.count == 1 {
      items.append(.event(pendingCommits[0]))
    } else {
      items.append(
        .commitGroup(
          id: "commit-group-\(pendingCommits[0].id)",
          author: pendingCommits[0].author,
          events: pendingCommits
        )
      )
    }
    pendingCommits = []
  }

  for event in events {
    if event.kind == .commit {
      if let last = pendingCommits.last, last.author != event.author {
        flushCommits()
      }
      pendingCommits.append(event)
    } else {
      flushCommits()
      items.append(.event(event))
    }
  }
  flushCommits()
  return items
}

/// One row of the Overview thread's chronological feed. Emitted directly as a
/// List row by `PrDetailScreen.overviewThreadRows` — never nested inside a
/// larger container — so offscreen events cost nothing.
struct PrTimelineDisplayRow: View {
  let item: PrTimelineDisplayItem

  var body: some View {
    switch item {
    case .event(let event):
      PrTimelineEventRow(event: event)
    case .commitGroup(_, let author, let events):
      PrTimelineCommitGroupRow(author: author, events: events)
    }
  }
}

/// Renders a single timeline event with desktop-parity treatments:
/// - commits → slim borderless one-line divider
/// - force pushes → centered divider text
/// - comments / reviews with bodies → thread cards
/// - everything else (lifecycle, labels, CI, deploys) → borderless inline row
struct PrTimelineEventRow: View {
  let event: PrTimelineEvent

  var body: some View {
    switch event.kind {
    case .commit:
      PrCommitDividerRow(event: event)
    case .forcePush:
      PrForcePushDividerRow(event: event)
    case .comment, .review:
      if let body = event.body?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
        PrTimelineCommentCard(event: event, bodyText: body)
      } else {
        PrTimelineInlineRow(event: event)
      }
    default:
      PrTimelineInlineRow(event: event)
    }
  }
}

/// Slim, borderless commit line: dot + subject + short SHA + relative time.
private struct PrCommitDividerRow: View {
  let event: PrTimelineEvent

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "circle.fill")
        .font(.system(size: 4))
        .foregroundStyle(ADEColor.textMuted)
      Text(event.title)
        .font(.system(size: 11.5, design: .monospaced))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer(minLength: 4)
      if let metadata = event.metadata, !metadata.isEmpty {
        Text(metadata)
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
      Text(prCompactRelativeTime(event.timestamp))
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
  }
}

/// Collapsible "author added N commits" group (desktop commit-group parity).
private struct PrTimelineCommitGroupRow: View {
  let author: String?
  let events: [PrTimelineEvent]

  @State private var expanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) { expanded.toggle() }
      } label: {
        HStack(spacing: 8) {
          Image(systemName: expanded ? "chevron.down" : "chevron.right")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
          Text("\(author.map { "@\($0)" } ?? "Someone") added \(events.count) commits")
            .font(.system(size: 11.5, weight: .medium))
            .foregroundStyle(ADEColor.textSecondary)
          Spacer(minLength: 4)
          Text(prCompactRelativeTime(events.last?.timestamp))
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)

      if expanded {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(events) { event in
            PrCommitDividerRow(event: event)
          }
        }
        .padding(.leading, 10)
      }
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
  }
}

/// Centered force-push divider (desktop parity).
private struct PrForcePushDividerRow: View {
  let event: PrTimelineEvent

  var body: some View {
    HStack(spacing: 8) {
      Rectangle()
        .fill(PrGlassPalette.cardBorder)
        .frame(height: 0.5)
      Text("\(event.author.map { "@\($0)" } ?? "someone") force-pushed")
        .font(.system(size: 10.5, design: .monospaced))
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
        .fixedSize()
      Rectangle()
        .fill(PrGlassPalette.cardBorder)
        .frame(height: 0.5)
    }
    .padding(.vertical, 2)
  }
}

/// Borderless one-line row for lifecycle / label / CI / deploy / bodyless
/// review events (desktop `InlineRow` parity).
private struct PrTimelineInlineRow: View {
  let event: PrTimelineEvent

  var body: some View {
    let tint = timelineTint(event.kind)
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: timelineSymbol(event.kind))
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(tint)
        .frame(width: 16)
      Group {
        if let author = event.author, !author.isEmpty {
          Text("@\(author) ")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          + Text(event.title)
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textSecondary)
        } else {
          Text(event.title)
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      .lineLimit(2)
      .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 4)
      Text(prCompactRelativeTime(event.timestamp))
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
  }
}

/// Thread card for comments and reviews that carry a body. Long bodies are
/// clamped with a tap-to-expand affordance so a verbose bot review doesn't
/// swallow the feed.
private struct PrTimelineCommentCard: View {
  let event: PrTimelineEvent
  let bodyText: String

  @State private var expanded = false

  private static let collapsedLineLimit = 10

  private var authorLogin: String { event.author ?? "unknown" }
  private var botProvider: PrBotProvider? { prBotProvider(from: authorLogin) }

  private var displayName: String {
    if let botProvider { return prBotDisplayName(botProvider) }
    return authorLogin
  }

  private var avatarLetter: String {
    if let botProvider { return prBotLetter(botProvider) }
    guard let first = authorLogin.first else { return "?" }
    return String(first).uppercased()
  }

  private var avatarTint: Color {
    botProvider != nil ? ADEColor.tintPRs : ADEColor.accent
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .center, spacing: 9) {
        ZStack {
          Circle().fill(avatarTint.opacity(0.16))
          Circle().strokeBorder(avatarTint.opacity(0.3), lineWidth: 0.5)
          Text(avatarLetter)
            .font(.system(size: 11, weight: .heavy))
            .foregroundStyle(avatarTint)
        }
        .frame(width: 26, height: 26)

        VStack(alignment: .leading, spacing: 1) {
          HStack(spacing: 5) {
            Text(displayName)
              .font(.subheadline.weight(.bold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            if botProvider != nil {
              PrTagChip(label: "bot", color: ADEColor.tintPRs)
            }
          }
          Text("\(event.title) · \(prRelativeTime(event.timestamp))")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
      }

      PrInlineCodeText(text: bodyText)
        .lineLimit(expanded ? nil : Self.collapsedLineLimit)

      if !expanded, bodyText.count > 600 || bodyText.filter({ $0 == "\n" }).count >= Self.collapsedLineLimit {
        Button {
          expanded = true
        } label: {
          Text("Show more")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
        }
        .buttonStyle(.plain)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 16)
  }
}

// MARK: - Suggestion parsing

private struct PrReviewSuggestion {
  let before: [String]
  let after: [String]

  func diffLines(startLine: Int?) -> [PrDiffLine] {
    var lines: [PrDiffLine] = []
    for (idx, row) in before.enumerated() {
      let lineNumber = startLine.map { String($0 + idx) }
      lines.append(PrDiffLine(lineNumber: lineNumber, text: row, kind: .removed))
    }
    for (idx, row) in after.enumerated() {
      let lineNumber = startLine.map { String($0 + idx) }
      lines.append(PrDiffLine(lineNumber: lineNumber, text: row, kind: .added))
    }
    return lines
  }

  static func extract(from body: String) -> PrReviewSuggestion? {
    guard let range = body.range(of: "```suggestion") else { return nil }
    let after = body[range.upperBound...]
    guard let closing = after.range(of: "```") else { return nil }
    let content = String(after[..<closing.lowerBound])
    let lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var trimmed = lines
    if let first = trimmed.first, first.trimmingCharacters(in: .whitespaces).isEmpty { trimmed.removeFirst() }
    if let last = trimmed.last, last.trimmingCharacters(in: .whitespaces).isEmpty { trimmed.removeLast() }
    guard !trimmed.isEmpty else { return nil }
    return PrReviewSuggestion(before: [], after: trimmed)
  }

  static func stripSuggestion(from body: String) -> String {
    var result = body
    while let range = result.range(of: "```suggestion") {
      let after = result[range.upperBound...]
      if let closing = after.range(of: "```") {
        let removeRange = range.lowerBound..<closing.upperBound
        result.removeSubrange(removeRange)
      } else {
        result.removeSubrange(range.lowerBound..<result.endIndex)
      }
    }
    return result.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
