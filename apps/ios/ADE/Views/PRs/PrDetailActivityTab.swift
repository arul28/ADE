import SwiftUI

// The Activity tab is repurposed as a Reviews tab. The `PrActivityTab`
// type name is preserved so `PrDetailScreen` keeps compiling while task #3
// wires the richer hero + tab picker. `PrReviewsTab` is an alias for
// semantically correct call sites.

typealias PrReviewsTab = PrActivityTab

struct PrActivityTab: View {
  let timeline: [PrTimelineEvent]
  let reviewThreads: [PrReviewThread]
  let reviews: [PrReview]
  let requestedReviewers: [PrUser]
  let authorLogin: String?
  let requiredApprovals: Int
  @Binding var commentInput: String
  let canAddComment: Bool
  let isLive: Bool
  let aiResolution: AiResolutionState?
  let isAiResolverBusy: Bool
  let onSubmitComment: () -> Void
  let onReplyToThread: (String, String) -> Void
  let onSetThreadResolved: (String, Bool) -> Void
  let onLaunchAiResolver: () -> Void
  let onStopAiResolver: () -> Void

  @State private var focusedThreadId: String?
  @State private var replyDraft: [String: String] = [:]

  init(
    timeline: [PrTimelineEvent],
    reviewThreads: [PrReviewThread],
    reviews: [PrReview] = [],
    requestedReviewers: [PrUser] = [],
    authorLogin: String? = nil,
    requiredApprovals: Int = 1,
    commentInput: Binding<String>,
    canAddComment: Bool,
    isLive: Bool,
    aiResolution: AiResolutionState? = nil,
    isAiResolverBusy: Bool = false,
    onSubmitComment: @escaping () -> Void,
    onReplyToThread: @escaping (String, String) -> Void,
    onSetThreadResolved: @escaping (String, Bool) -> Void,
    onLaunchAiResolver: @escaping () -> Void = {},
    onStopAiResolver: @escaping () -> Void = {}
  ) {
    self.timeline = timeline
    self.reviewThreads = reviewThreads
    self.reviews = reviews
    self.requestedReviewers = requestedReviewers
    self.authorLogin = authorLogin
    self.requiredApprovals = requiredApprovals
    self._commentInput = commentInput
    self.canAddComment = canAddComment
    self.isLive = isLive
    self.aiResolution = aiResolution
    self.isAiResolverBusy = isAiResolverBusy
    self.onSubmitComment = onSubmitComment
    self.onReplyToThread = onReplyToThread
    self.onSetThreadResolved = onSetThreadResolved
    self.onLaunchAiResolver = onLaunchAiResolver
    self.onStopAiResolver = onStopAiResolver
  }

  private var sortedThreads: [PrReviewThread] {
    reviewThreads.sorted {
      if $0.isResolved != $1.isResolved {
        return !$0.isResolved && $1.isResolved
      }
      let l = prParsedDate($0.updatedAt ?? $0.createdAt) ?? .distantPast
      let r = prParsedDate($1.updatedAt ?? $1.createdAt) ?? .distantPast
      return l > r
    }
  }

  private var unresolvedThreads: [PrReviewThread] { sortedThreads.filter { !$0.isResolved } }
  private var resolvedThreads: [PrReviewThread] { sortedThreads.filter { $0.isResolved } }

  private var approvalCount: Int {
    reviews.filter { $0.state == "approved" }.count
  }

  private var requestedChangesCount: Int {
    reviews.filter { $0.state == "changes_requested" }.count
  }

  private var botReviews: [PrBotReviewAggregate] {
    PrBotReviewAggregate.build(from: reviews)
  }

  private var humanReviewers: [PrHumanReviewer] {
    PrHumanReviewer.build(
      requestedReviewers: requestedReviewers,
      reviews: reviews,
      authorLogin: authorLogin
    )
  }

  private var aiResolverRunning: Bool {
    let status = aiResolution?.status?.lowercased() ?? ""
    return status == "running" || status == "starting" || status == "pending"
  }

  private var focusedTargetName: String {
    if let focusedThreadId,
       let thread = reviewThreads.first(where: { $0.id == focusedThreadId }),
       let author = thread.comments.first?.author, !author.isEmpty {
      return author
    }
    return "PR"
  }

  private var timelineRail: some View {
    HStack {
      ZStack(alignment: .top) {
        Rectangle()
          .fill(Color.clear)
          .frame(width: 1)
        Path { p in
          p.move(to: CGPoint(x: 0.5, y: 0))
          p.addLine(to: CGPoint(x: 0.5, y: 10000))
        }
        .stroke(
          LinearGradient(
            colors: [ADEColor.purpleAccent.opacity(0.0), ADEColor.purpleAccent.opacity(0.25), ADEColor.purpleAccent.opacity(0.0)],
            startPoint: .top,
            endPoint: .bottom
          ),
          style: StrokeStyle(lineWidth: 1, dash: [2, 4])
        )
        .frame(width: 1)
      }
      .frame(width: 1)
      .padding(.leading, 3)
      Spacer()
    }
    .allowsHitTesting(false)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      PrApprovalSummaryCard(
        approvalCount: approvalCount,
        requiredApprovals: requiredApprovals,
        requestedChangesCount: requestedChangesCount,
        unresolvedCount: unresolvedThreads.count,
        firstRequestedReviewer: requestedReviewers.first?.login,
        latestReviewedAt: reviews.compactMap { $0.submittedAt }.max()
      )

      // Chronological timeline — the primary view on the Activity tab,
      // mirroring desktop where commits/comments/reviews/deployments interleave
      // in one stream. Threads + reviewer summaries below remain available as
      // secondary surfaces.
      if !timeline.isEmpty {
        PrActivityTimelineList(events: timeline)
      }

      PrAiResolverCtaCard(
        variant: .inline,
        isBusy: isAiResolverBusy,
        isRunning: aiResolverRunning,
        isLive: isLive,
        onLaunch: onLaunchAiResolver,
        onStop: onStopAiResolver
      )

      if !unresolvedThreads.isEmpty {
        sectionHeader(title: "Threads", trailing: "\(unresolvedThreads.count) unresolved")
        ForEach(unresolvedThreads) { thread in
          PrReviewThreadCard(
            thread: thread,
            isLive: isLive,
            isFocused: focusedThreadId == thread.id,
            replyDraft: Binding(
              get: { replyDraft[thread.id] ?? "" },
              set: { replyDraft[thread.id] = $0 }
            ),
            onFocus: { focusedThreadId = thread.id },
            onReply: { body in
              onReplyToThread(thread.id, body)
              replyDraft[thread.id] = ""
            },
            onResolve: { resolved in onSetThreadResolved(thread.id, resolved) }
          )
        }
      }

      if !resolvedThreads.isEmpty {
        PrCollapsibleResolvedSection(
          threads: resolvedThreads,
          isLive: isLive,
          onReopen: { threadId in onSetThreadResolved(threadId, false) }
        )
      }

      if !botReviews.isEmpty {
        sectionHeader(title: "Bot feedback", trailing: "\(botReviews.count) bot\(botReviews.count == 1 ? "" : "s")")
        VStack(spacing: 0) {
          ForEach(Array(botReviews.enumerated()), id: \.1.id) { index, item in
            if index > 0 {
              Divider().overlay(ADEColor.glassBorder)
            }
            PrBotReviewRow(item: item)
          }
        }
        .prGlassCard(cornerRadius: 18)
      }

      if !humanReviewers.isEmpty {
        sectionHeader(title: "Reviewers", trailing: nil)
        VStack(spacing: 0) {
          ForEach(Array(humanReviewers.enumerated()), id: \.1.id) { index, reviewer in
            if index > 0 {
              Divider().overlay(ADEColor.glassBorder)
            }
            PrHumanReviewerRow(reviewer: reviewer)
          }
        }
        .prGlassCard(cornerRadius: 18)
      }

      if unresolvedThreads.isEmpty && resolvedThreads.isEmpty && botReviews.isEmpty && humanReviewers.isEmpty && timeline.isEmpty {
        ADEEmptyStateView(
          symbol: "bubble.left.and.bubble.right",
          title: "No reviews yet",
          message: "Review threads and reviewer responses will appear here once the host syncs them."
        )
      }

      PrReplyComposer(
        text: $commentInput,
        placeholder: focusedThreadId != nil ? "Reply to \(focusedTargetName)…" : "Comment on PR…",
        isLive: isLive && canAddComment,
        onSend: {
          if let focusedThreadId {
            onReplyToThread(focusedThreadId, commentInput)
            commentInput = ""
          } else {
            onSubmitComment()
          }
        },
        onClearFocus: focusedThreadId != nil ? { focusedThreadId = nil } : nil
      )

      if !canAddComment {
        Text("Posting comments requires a host that exposes PR comment actions to mobile.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
    .background(timelineRail, alignment: .topLeading)
  }

  @ViewBuilder
  private func sectionHeader(title: String, trailing: String?) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(title.uppercased())
        .font(.system(size: 11, weight: .semibold, design: .monospaced))
        .tracking(1.2)
        .foregroundColor(ADEColor.textSecondary)
      Spacer(minLength: 12)
      if let trailing {
        Text(trailing)
          .font(.system(size: 11, weight: .semibold, design: .monospaced))
          .foregroundColor(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 4)
    .padding(.top, 4)
  }
}

// MARK: - Approval summary

private struct PrApprovalSummaryCard: View {
  let approvalCount: Int
  let requiredApprovals: Int
  let requestedChangesCount: Int
  let unresolvedCount: Int
  let firstRequestedReviewer: String?
  let latestReviewedAt: String?

  private var ratio: String { "\(approvalCount)/\(max(requiredApprovals, 1))" }

  private var isReady: Bool {
    approvalCount >= max(requiredApprovals, 1) && requestedChangesCount == 0
  }

  private var tint: Color {
    if requestedChangesCount > 0 { return ADEColor.danger }
    if isReady { return ADEColor.success }
    return ADEColor.warning
  }

  private var title: String {
    if requestedChangesCount > 0 { return "Changes requested" }
    if isReady { return "Approved" }
    return "Awaiting approval"
  }

  private var subtitle: String {
    if let reviewer = firstRequestedReviewer, !reviewer.isEmpty {
      let ago = prRelativeTime(latestReviewedAt)
      return "@\(reviewer) · review requested \(ago)"
    }
    return "No reviewers requested"
  }

  var body: some View {
    HStack(spacing: 10) {
      ZStack {
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .fill(tint.opacity(0.14))
          .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
              .strokeBorder(tint.opacity(0.3), lineWidth: 0.5)
          )
        Text(ratio)
          .font(.system(.footnote, design: .monospaced).weight(.bold))
          .foregroundStyle(tint)
      }
      .frame(width: 36, height: 36)

      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.subheadline.weight(.bold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(subtitle)
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }

      Spacer(minLength: 8)

      if unresolvedCount > 0 {
        PrTagChip(label: "\(unresolvedCount) unresolved", color: ADEColor.warning)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .prGlassCard(cornerRadius: 18)
  }
}

// MARK: - Thread card

private struct PrReviewThreadCard: View {
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
      tint: isFocused ? PrGlassPalette.purple.opacity(0.6) : nil,
      strokeOpacity: isFocused ? 0.35 : 0.10,
      highlightOpacity: isFocused ? 0.22 : 0.14
    )
    .overlay(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .strokeBorder(PrGlassPalette.purple.opacity(isFocused ? 0.55 : 0), lineWidth: 0.75)
    )
    .shadow(
      color: isFocused ? PrGlassPalette.purpleDeep.opacity(0.4) : .clear,
      radius: isFocused ? 18 : 0,
      y: 0
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

private struct PrInlineCodeText: View {
  let text: String

  var body: some View {
    Text(renderAttributed())
      .font(.system(.footnote))
      .foregroundStyle(ADEColor.textPrimary)
      .multilineTextAlignment(.leading)
      .fixedSize(horizontal: false, vertical: true)
  }

  private func renderAttributed() -> AttributedString {
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

private struct PrCollapsibleResolvedSection: View {
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

// MARK: - Bot review aggregate

private struct PrBotReviewAggregate: Identifiable {
  let id: String
  let provider: PrBotProvider
  let approvedCount: Int
  let changesRequestedCount: Int
  let commentedCount: Int
  let lastBody: String?

  var primaryState: String {
    if changesRequestedCount > 0 { return "actionable" }
    if approvedCount > 0 { return "approved" }
    return "commented"
  }

  var summary: String {
    if changesRequestedCount > 0 {
      let suggestions = "\(changesRequestedCount) suggestion\(changesRequestedCount == 1 ? "" : "s")"
      if commentedCount > 0 {
        return "\(suggestions) · \(commentedCount) nitpick\(commentedCount == 1 ? "" : "s")"
      }
      return suggestions
    }
    if approvedCount > 0 { return "No blocking issues" }
    if let lastBody {
      let trimmed = lastBody.trimmingCharacters(in: .whitespacesAndNewlines)
      return String(trimmed.prefix(50))
    }
    return "Review posted"
  }

  static func build(from reviews: [PrReview]) -> [PrBotReviewAggregate] {
    var groups: [String: (provider: PrBotProvider, list: [PrReview])] = [:]
    for review in reviews {
      guard let provider = prBotProvider(from: review.reviewer) else { continue }
      var entry = groups[provider.rawValue] ?? (provider, [])
      entry.list.append(review)
      groups[provider.rawValue] = entry
    }
    return groups.values.map { entry -> PrBotReviewAggregate in
      var approved = 0, changes = 0, commented = 0
      for review in entry.list {
        switch review.state {
        case "approved": approved += 1
        case "changes_requested": changes += 1
        default: commented += 1
        }
      }
      let latest = entry.list.sorted { (a, b) in
        (prParsedDate(a.submittedAt) ?? .distantPast) > (prParsedDate(b.submittedAt) ?? .distantPast)
      }.first
      return PrBotReviewAggregate(
        id: entry.provider.rawValue,
        provider: entry.provider,
        approvedCount: approved,
        changesRequestedCount: changes,
        commentedCount: commented,
        lastBody: latest?.body
      )
    }.sorted { prBotDisplayName($0.provider) < prBotDisplayName($1.provider) }
  }
}

private struct PrBotReviewRow: View {
  let item: PrBotReviewAggregate

  private var stateTint: Color {
    switch item.primaryState {
    case "actionable": return ADEColor.warning
    case "approved": return ADEColor.success
    default: return ADEColor.textSecondary
    }
  }

  var body: some View {
    HStack(spacing: 10) {
      ZStack {
        Circle().fill(ADEColor.tintPRs.opacity(0.18))
        Circle().strokeBorder(ADEColor.tintPRs.opacity(0.3), lineWidth: 0.5)
        Text(prBotLetter(item.provider))
          .font(.system(size: 11, weight: .heavy))
          .foregroundStyle(ADEColor.tintPRs)
      }
      .frame(width: 26, height: 26)
      VStack(alignment: .leading, spacing: 2) {
        Text(prBotDisplayName(item.provider))
          .font(.footnote.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(item.summary)
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
      Spacer(minLength: 8)
      PrTagChip(label: item.primaryState, color: stateTint)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }
}

// MARK: - Human reviewers

private struct PrHumanReviewer: Identifiable {
  let id: String
  let login: String
  let role: String
  let state: String
  let ago: String?
}

private extension PrHumanReviewer {
  static func build(requestedReviewers: [PrUser], reviews: [PrReview], authorLogin: String?) -> [PrHumanReviewer] {
    var seen = Set<String>()
    var result: [PrHumanReviewer] = []

    if let author = authorLogin, !author.isEmpty, prBotProvider(from: author) == nil {
      result.append(PrHumanReviewer(id: "author-\(author)", login: author, role: "author", state: "author", ago: nil))
      seen.insert(author)
    }

    for user in requestedReviewers where prBotProvider(from: user.login) == nil {
      if seen.contains(user.login) { continue }
      let latest = reviews.filter { $0.reviewer == user.login }.sorted { (a, b) in
        (prParsedDate(a.submittedAt) ?? .distantPast) > (prParsedDate(b.submittedAt) ?? .distantPast)
      }.first
      let state = latest?.state ?? "pending"
      result.append(PrHumanReviewer(
        id: "requested-\(user.login)",
        login: user.login,
        role: "requested",
        state: mapReviewStateToToken(state),
        ago: prRelativeTime(latest?.submittedAt)
      ))
      seen.insert(user.login)
    }

    for review in reviews where prBotProvider(from: review.reviewer) == nil {
      if seen.contains(review.reviewer) { continue }
      result.append(PrHumanReviewer(
        id: "review-\(review.reviewer)",
        login: review.reviewer,
        role: reviewRoleLabel(for: review.state),
        state: mapReviewStateToToken(review.state),
        ago: prRelativeTime(review.submittedAt)
      ))
      seen.insert(review.reviewer)
    }
    return result
  }

  private static func mapReviewStateToToken(_ state: String) -> String {
    switch state {
    case "approved": return "approved"
    case "changes_requested": return "changes"
    case "pending", "requested": return "pending"
    default: return state
    }
  }

  private static func reviewRoleLabel(for state: String) -> String {
    switch state {
    case "approved": return "approved"
    case "changes_requested": return "changes requested"
    default: return "commented"
    }
  }
}

private struct PrHumanReviewerRow: View {
  let reviewer: PrHumanReviewer

  private var stateTint: Color {
    switch reviewer.state {
    case "approved": return ADEColor.success
    case "pending", "requested": return ADEColor.warning
    case "changes": return ADEColor.danger
    case "author": return ADEColor.textSecondary
    default: return ADEColor.textSecondary
    }
  }

  var body: some View {
    HStack(spacing: 10) {
      ZStack {
        Circle().fill(ADEColor.accent.opacity(0.16))
        Circle().strokeBorder(ADEColor.accent.opacity(0.3), lineWidth: 0.5)
        Text(String(reviewer.login.prefix(1)).uppercased())
          .font(.system(size: 11, weight: .heavy))
          .foregroundStyle(ADEColor.accent)
      }
      .frame(width: 28, height: 28)
      VStack(alignment: .leading, spacing: 2) {
        Text(reviewer.login)
          .font(.footnote.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(reviewer.role + (reviewer.ago.map { " · \($0)" } ?? ""))
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }
      Spacer(minLength: 8)
      PrTagChip(label: reviewer.state, color: stateTint)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }
}

// MARK: - Reply composer

private struct PrReplyComposer: View {
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
          .background(
            PrGlassPalette.accentGradient,
            in: Circle()
          )
          .overlay(Circle().strokeBorder(Color.white.opacity(0.28), lineWidth: 0.5))
          .overlay(
            Circle()
              .inset(by: 1)
              .stroke(Color.white.opacity(0.22), lineWidth: 0.5)
              .blendMode(.plusLighter)
          )
          .shadow(color: PrGlassPalette.purpleDeep.opacity(0.55), radius: 10, y: 3)
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

// MARK: - Activity timeline

/// Chronological event list used at the top of the Activity tab. Each row is
/// avatar-disc + colored event label + body. The vertical hairline behind the
/// dots threads the events together, matching the desktop's timeline column.
struct PrActivityTimelineList: View {
  let events: [PrTimelineEvent]

  private var sorted: [PrTimelineEvent] {
    events.sorted { (a, b) in
      let l = prParsedDate(a.timestamp) ?? .distantPast
      let r = prParsedDate(b.timestamp) ?? .distantPast
      return l > r
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("TIMELINE")
          .font(.system(size: 10, weight: .bold))
          .tracking(1.0)
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 8)
        Text("\(events.count)")
          .font(.system(size: 11, weight: .bold, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 4)

      VStack(spacing: 0) {
        ForEach(Array(sorted.enumerated()), id: \.element.id) { index, event in
          PrActivityTimelineRow(
            event: event,
            isFirst: index == 0,
            isLast: index == sorted.count - 1
          )
        }
      }
      .prGlassCard(cornerRadius: 16)
    }
  }
}

/// Single timeline row. The left rail is a 22pt-wide column with the dot in
/// the middle and stub-lines top/bottom that join into a continuous rail.
private struct PrActivityTimelineRow: View {
  let event: PrTimelineEvent
  let isFirst: Bool
  let isLast: Bool

  private var tint: Color { timelineTint(event.kind) }
  private var symbol: String { timelineSymbol(event.kind) }

  private var ago: String { prRelativeTime(event.timestamp) }

  private var kindLabel: String {
    switch event.kind {
    case .stateChange: return "state"
    case .review: return "review"
    case .comment: return "comment"
    case .deployment: return "deploy"
    case .commit: return "commit"
    case .label: return "label"
    case .ci: return "ci"
    case .forcePush: return "force-push"
    case .reviewRequest: return "request"
    }
  }

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      // Rail column with vertical hairline + dot.
      ZStack(alignment: .top) {
        VStack(spacing: 0) {
          Rectangle()
            .fill(isFirst ? Color.clear : ADEColor.textMuted.opacity(0.22))
            .frame(width: 1, height: 14)
          Rectangle()
            .fill(isLast ? Color.clear : ADEColor.textMuted.opacity(0.22))
            .frame(width: 1)
            .frame(maxHeight: .infinity)
        }
        .frame(width: 22)

        ZStack {
          Circle()
            .fill(tint.opacity(0.18))
            .frame(width: 22, height: 22)
          Circle()
            .strokeBorder(tint.opacity(0.45), lineWidth: 0.75)
            .frame(width: 22, height: 22)
          Image(systemName: symbol)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
        }
        .padding(.top, 8)
      }
      .frame(width: 28)

      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          Text(kindLabel.uppercased())
            .font(.system(size: 9, weight: .bold))
            .tracking(0.6)
            .foregroundStyle(tint)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(Capsule().fill(tint.opacity(0.16)))
            .overlay(Capsule().strokeBorder(tint.opacity(0.32), lineWidth: 0.5))
          if let author = event.author, !author.isEmpty {
            Text("@\(author)")
              .font(.system(size: 11, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
          }
          Spacer(minLength: 4)
          Text(ago)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
        }

        Text(event.title)
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)

        if let body = event.body, !body.isEmpty {
          let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
          if !trimmed.isEmpty {
            Text(trimmed)
              .font(.system(size: 11))
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(3)
              .fixedSize(horizontal: false, vertical: true)
          }
        }

        if let metadata = event.metadata, !metadata.isEmpty {
          Text(metadata)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }
      .padding(.vertical, 10)
      .padding(.trailing, 12)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
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
