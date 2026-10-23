import SwiftUI

// The top and bottom of the PR detail screen on the flat base: the nav-bar
// title (number, author, state), the header (title, branches, age, lane) and
// the bar with the next step and its one action.

/// "3d ago", or "3d · updated 2h" when it moved since: short enough to sit
/// beside the author and the state pill without truncating.
func prFlatHeaderAge(createdAt: String?, updatedAt: String?) -> String? {
  let created = prCompactRelativeTime(createdAt)
  guard !created.isEmpty else { return nil }
  let updated = prCompactRelativeTime(updatedAt)
  guard !updated.isEmpty, updated != created else {
    return created == "now" ? "just now" : "\(created) ago"
  }
  return "\(created) · updated \(updated)"
}

struct PrFlatDetailHeader: View {
  let createdAt: String?
  let updatedAt: String?
  let title: String
  let baseBranch: String
  let headBranch: String
  let laneName: String?
  let ghostLaneName: String?
  /// The lane's machine, when the repository is on more than one.
  let machineName: String?
  let stackLabel: String?
  let onOpenLane: (() -> Void)?
  let onOpenStack: (() -> Void)?
  let canCreateLane: Bool
  let canLinkLane: Bool
  let onCreateLane: () -> Void
  let onLinkLane: () -> Void
  /// False where the title already sits in the navigation bar (the Duo).
  var showsTitle = true

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if showsTitle {
        Text(title)
          .font(.title3.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      }
      // The number, author and state ride in the navigation bar
      // (`PrFlatDetailNavTitle`); the age joins the branch line.
      if !baseBranch.isEmpty || !headBranch.isEmpty {
        HStack(spacing: 6) {
          Text(verbatim: "\(baseBranch) ← \(headBranch)")
            .font(.adeMono(11.5))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
          if let age = prFlatHeaderAge(createdAt: createdAt, updatedAt: updatedAt) {
            Spacer(minLength: 4)
            Text(age)
              .font(.caption)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
              .fixedSize()
          }
        }
      }
      HStack(spacing: 6) {
        if let laneName, !laneName.isEmpty {
          Button { onOpenLane?() } label: {
            ADEKitChip(symbol: "arrow.triangle.branch", text: laneName, tint: ADEColor.textPrimary)
          }
          .buttonStyle(.plain)
          .disabled(onOpenLane == nil)
          .accessibilityHint("Opens the lane")
          if let machineName {
            ADEKitChip(symbol: "desktopcomputer", text: machineName)
          }
        } else {
          if let ghostLaneName, !ghostLaneName.isEmpty {
            ADEKitChip(symbol: nil, text: "was: \(ghostLaneName)", tint: ADEColor.textMuted)
          }
          if canCreateLane || canLinkLane {
            Menu {
              if canCreateLane {
                Button(action: onCreateLane) { Label("Create lane from branch", systemImage: "plus.square.on.square") }
              }
              if canLinkLane {
                Button(action: onLinkLane) { Label("Link an existing lane", systemImage: "link") }
              }
            } label: {
              ADEKitChip(symbol: "plus", text: "Lane", tint: ADEColor.accent)
            }
            .accessibilityLabel("Add a lane for this PR")
          }
        }
        if let stackLabel {
          Button { onOpenStack?() } label: {
            ADEKitChip(symbol: "square.stack.3d.up", text: stackLabel)
          }
          .buttonStyle(.plain)
          .disabled(onOpenStack == nil)
        }
        Spacer(minLength: 0)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// The PR's number, author and state in the navigation bar, between the back
/// and actions buttons: the bar row was otherwise empty, and the header below
/// spent a line repeating it.
struct PrFlatDetailNavTitle: View {
  let number: Int
  let author: String?
  let authorIsBot: Bool?
  let state: String

  var body: some View {
    HStack(spacing: 6) {
      Text(verbatim: "#\(number)")
        .font(.adeMono(13, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
      if let author, !author.isEmpty {
        PrAvatar(login: author, isBot: authorIsBot, size: 16)
        Text(author)
          .font(.footnote.weight(.medium))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      PrStatePill(state: state)
    }
    .accessibilityElement(children: .combine)
  }
}

struct PrFlatDetailHeaderSkeleton: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        ADESkeletonView(width: 140, height: 12, cornerRadius: 3)
        Spacer()
        ADESkeletonView(width: 56, height: 16, cornerRadius: 4)
      }
      ADESkeletonView(height: 18, cornerRadius: 4)
      ADESkeletonView(width: 220, height: 18, cornerRadius: 4)
      ADESkeletonView(width: 180, height: 11, cornerRadius: 3)
    }
  }
}

/// The slim bar above the tab bar: the next step on the left, one main action
/// on the right. Never opens a sheet: the text jumps to the tab that explains it.
struct PrNextStepFlatBar<Primary: View>: View {
  let step: PrNextStep
  let isBusy: Bool
  let busyLabel: String?
  let onTapText: () -> Void
  /// Whether the PR's merge state is known. Until it is, the bar says so and
  /// offers no action: a cold open used to show "Ready to merge" and a live
  /// Merge button before GitHub's answer arrived.
  var mergeStatus: PrMergeStatusPresence = .known
  @ViewBuilder let primary: () -> Primary

  private var headline: String {
    switch mergeStatus {
    case .known: return step.headline
    case .checking: return "Checking merge status…"
    case .unavailable: return "Merge status unavailable"
    }
  }

  /// The next thing in the way after the headline, never the headline again.
  private var subline: String? {
    if let busyLabel { return busyLabel }
    let restated: String?
    switch step.kind {
    case .checksFailing, .checksPending: restated = "checks"
    case .behind: restated = "up_to_date"
    case .conflicts: restated = "conflicts"
    case .changesRequested, .reviewRequired: restated = "review"
    default: restated = nil
    }
    let chips = step.chips.filter { $0.id != restated }
    if let chip = chips.first(where: { $0.state == .fail }) ?? chips.first(where: { $0.state == .pending }) {
      return chip.label
    }
    // The detail of a checks / behind / conflicts / review step says the
    // headline again ("1 check failing" / "1 failing check").
    return restated == nil ? step.detail : nil
  }

  var body: some View {
    HStack(spacing: 10) {
      Button(action: onTapText) {
        HStack(spacing: 9) {
          if isBusy || mergeStatus == .checking {
            ProgressView().controlSize(.small)
          } else {
            Circle()
              .fill(mergeStatus == .unavailable ? ADEColor.textMuted : prNextStepColor(step.tone))
              .frame(width: 8, height: 8)
          }
          VStack(alignment: .leading, spacing: 1) {
            Text(headline)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            if mergeStatus == .unavailable {
              Text("Pull down to check again")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
            } else if mergeStatus == .known, let subline {
              Text(subline)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
            }
          }
          Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(mergeStatus == .known ? "Next step: \(step.headline)" : headline)
      if mergeStatus == .known {
        primary()
      }
    }
    .padding(.leading, 16)
    .padding(.trailing, 8)
    .padding(.vertical, 8)
    .frame(minHeight: 52)
    // Opaque: the glass let the description read through the bar.
    .background(ADEKit.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(ADEKit.edge, lineWidth: 0.75)
    }
    .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
    .padding(.horizontal, 12)
    .padding(.bottom, 6)
  }
}

func prNextStepColor(_ tone: PrNextStepTone) -> Color {
  switch tone {
  case .success: return ADEColor.success
  case .danger: return ADEColor.danger
  case .warning: return ADEColor.warning
  case .info: return ADEColor.info
  case .merged: return prStateColor("merged")
  case .neutral: return ADEColor.textMuted
  }
}

/// The cleaned PR description as markdown on the page, `<details>` blocks as
/// disclosures.
struct PrFlatDescription: View {
  private let blocks: [PrGitHubDescriptionBlock]
  @State private var expanded: Set<String> = []

  init(text: String) {
    blocks = parsePrGitHubDescriptionBlocks(text)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(blocks) { block in
        switch block {
        case .markdown(_, let markdown):
          PrMarkdownRenderer(markdown: markdown)
        case .disclosure(let id, let title, let markdown):
          DisclosureGroup(isExpanded: Binding(
            get: { expanded.contains(id) },
            set: { if $0 { expanded.insert(id) } else { expanded.remove(id) } }
          )) {
            PrMarkdownRenderer(markdown: markdown).padding(.top, 6)
          } label: {
            Text(title)
              .font(.subheadline.weight(.medium))
              .foregroundStyle(ADEColor.textPrimary)
              .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
              .contentShape(Rectangle())
          }
          .tint(ADEColor.textSecondary)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Whether a PR detail knows its merge state: from its snapshot, still loading
/// it, or done loading without one (offline, or the read failed).
enum PrMergeStatusPresence: Equatable {
  case known
  case checking
  case unavailable
}

// MARK: - Duo: the dock and the push rail

/// The bubbles of desktop's floating dock. On the Duo's inner display each is a
/// toolbar item of the PR's column (so held landscape they ride the edge bar)
/// and opens its card as a popover.
enum PrDuoDock: String, CaseIterable, Identifiable {
  case merge, comment, reviewers, labels, assignees

  var id: String { rawValue }

  var title: String {
    switch self {
    case .merge: return "Merge"
    case .comment: return "Comment"
    case .reviewers: return "Reviewers"
    case .labels: return "Labels"
    case .assignees: return "Assignees"
    }
  }

  var symbol: String {
    switch self {
    case .merge: return "arrow.triangle.merge"
    case .comment: return "text.bubble"
    case .reviewers: return "person.2"
    case .labels: return "tag"
    case .assignees: return "person.crop.circle"
    }
  }
}

/// The Merge bubble's ring: green ready, amber blocked or waiting, red failing,
/// purple merged; grey while the merge state is not known.
func prDuoMergeRingColor(_ step: PrNextStep, mergeStatus: PrMergeStatusPresence) -> Color {
  switch step.kind {
  case .merged: return prStateColor("merged")
  case .closed: return ADEColor.textMuted
  default: break
  }
  guard mergeStatus == .known else { return ADEColor.textMuted }
  switch step.tone {
  case .success: return ADEColor.success
  case .danger: return ADEColor.danger
  default: return ADEColor.warning
  }
}

/// The Merge bubble: the merge symbol inside a ring in the merge state's color.
struct PrDuoMergeBubbleLabel: View {
  let ring: Color

  var body: some View {
    ZStack {
      Circle()
        .strokeBorder(ring, lineWidth: 2)
        .frame(width: 26, height: 26)
      Image(systemName: "arrow.triangle.merge")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(ring)
    }
    .frame(width: 32, height: 32)
    .contentShape(Rectangle())
  }
}

/// The card frame every dock popover shares: a fixed width, the card's
/// title, and the system popover background.
struct PrDuoCard<Content: View>: View {
  let dock: PrDuoDock
  var width: CGFloat = 340
  @ViewBuilder let content: () -> Content

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        Label(dock.title, systemImage: dock.symbol)
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
        content()
      }
      .padding(18)
      .frame(width: width, alignment: .leading)
    }
    .scrollBounceBehavior(.basedOnSize)
    .frame(width: width)
    .frame(maxHeight: 560)
    .fixedSize(horizontal: false, vertical: true)
    .presentationCompactAdaptation(.popover)
  }
}

/// Inset rows for a card, like a grouped list section.
struct PrDuoCardRows<Content: View>: View {
  @ViewBuilder let content: () -> Content

  var body: some View {
    VStack(spacing: 0) {
      Group(subviews: content()) { rows in
        ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
          if index > 0 {
            Divider().padding(.leading, 12)
          }
          row
            .padding(.horizontal, 12)
            .frame(minHeight: 38)
        }
      }
    }
    .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }
}

/// What a stacked PR's merge covers, for its Merge card.
struct PrDuoStackMerge: Equatable {
  let position: Int
  let size: Int
  /// Open PRs one merge lands, this one included.
  let count: Int
}

/// Desktop's Merge card: the next step, the requirement checklist, the method
/// and the buttons that act on it; once merged, the cleanup.
struct PrDuoMergeCard: View {
  let step: PrNextStep
  let mergeStatus: PrMergeStatusPresence
  let busyLabel: String?
  let stack: PrDuoStackMerge?
  let isDraft: Bool
  /// "Merged into main by arul28 · 3h ago" for a merged PR.
  let mergedSummary: String?
  @Binding var method: PrMergeMethodOption
  let canMergeAnyway: Bool
  let canArchiveLane: Bool
  let label: (PrNextStepAction) -> String
  let isAvailable: (PrNextStepAction) -> Bool
  let onRun: (PrNextStepAction) -> Void
  let onMerge: () -> Void
  let onMergeAnyway: () -> Void
  let onStackMerge: () -> Void
  let onArchiveLane: () -> Void
  let onChip: (PrRequirementChip) -> Void

  private var isBusy: Bool { busyLabel != nil }
  private var tone: Color {
    mergeStatus == .known ? prNextStepColor(step.tone) : ADEColor.textMuted
  }

  private var headline: String {
    switch mergeStatus {
    case .known: return step.headline
    case .checking: return "Checking merge status…"
    case .unavailable: return "Merge status unavailable"
    }
  }

  private var glyph: String {
    switch step.kind {
    case .merged, .ready, .autoMergeArmed, .draft: return "arrow.triangle.merge"
    case .closed: return "xmark.circle.fill"
    case .computing, .checksPending: return "clock.fill"
    default: return "exclamationmark.circle.fill"
    }
  }

  private var isOpen: Bool { step.kind != .merged && step.kind != .closed }

  var body: some View {
    PrDuoCard(dock: .merge) {
      HStack(alignment: step.detail == nil ? .center : .top, spacing: 12) {
        ZStack {
          Circle().fill(tone.opacity(0.15)).frame(width: 34, height: 34)
          if mergeStatus == .checking {
            ProgressView().controlSize(.small)
          } else {
            Image(systemName: glyph)
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(tone)
          }
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(headline)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
          if mergeStatus == .known, let detail = step.detail {
            Text(detail)
              .font(.footnote)
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          } else if mergeStatus == .unavailable {
            Text("Pull down on the thread to check again.")
              .font(.footnote)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
      }

      if mergeStatus == .known, !step.chips.isEmpty {
        PrDuoCardRows {
          ForEach(step.chips) { chip in
            Button { onChip(chip) } label: {
              HStack(spacing: 9) {
                chipGlyph(chip.state)
                Text(chip.label)
                  .font(.footnote)
                  .foregroundStyle(chip.state == .pass ? ADEColor.textSecondary : ADEColor.textPrimary)
                Spacer(minLength: 0)
              }
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
          }
        }
      }

      if let mergedSummary {
        Text(mergedSummary)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
      }

      if let stack, isOpen {
        stackSection(stack)
      } else if mergeStatus == .known {
        actionSection
      }

      if !isOpen, canArchiveLane {
        cleanupSection
      }

      if let busyLabel {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text(busyLabel).font(.footnote).foregroundStyle(ADEColor.textSecondary)
        }
      }
    }
  }

  @ViewBuilder
  private var actionSection: some View {
    let primary = step.primary.flatMap { isAvailable($0) ? $0 : nil }
    let secondary = step.secondary.flatMap { isAvailable($0) ? $0 : nil }
    let anyway = step.mergeAnyway
    if primary == .merge || (anyway.visible && !anyway.blocked && canMergeAnyway) {
      Picker("Merge method", selection: $method) {
        ForEach(PrMergeMethodOption.allCases) { option in
          Text(option.shortTitle).tag(option)
        }
      }
      .pickerStyle(.segmented)
    }
    if let primary, isOpen {
      Button {
        ADEHaptics.light()
        primary == .merge ? onMerge() : onRun(primary)
      } label: {
        Label(primary == .merge ? "Merge · \(method.shortTitle)" : label(primary), systemImage: primary == .merge ? "arrow.triangle.merge" : "arrow.right.circle")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .tint(primary == .merge ? ADEColor.success : tone)
      .disabled(isBusy)
    }
    if let secondary {
      Button {
        onRun(secondary)
      } label: {
        Text(label(secondary)).frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered)
      .controlSize(.large)
      .disabled(isBusy)
    }
    if anyway.visible, canMergeAnyway {
      Button(role: anyway.bypass ? .destructive : nil) {
        onMergeAnyway()
      } label: {
        Label(anyway.bypass ? "Bypass rules and merge" : "Merge anyway", systemImage: "arrow.triangle.merge")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered)
      .controlSize(.large)
      .tint(anyway.bypass ? ADEColor.danger : nil)
      .disabled(anyway.blocked || isBusy)
      if anyway.blocked, let reason = anyway.blockedReason {
        Text(reason).font(.caption).foregroundStyle(ADEColor.textMuted)
      } else if !anyway.skips.isEmpty {
        Text("Skips \(anyway.skips.joined(separator: ", ")).")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    if primary == nil, !isOpen, step.kind == .closed {
      EmptyView()
    }
  }

  @ViewBuilder
  private func stackSection(_ stack: PrDuoStackMerge) -> some View {
    Label("GitHub Stack \(stack.position) of \(stack.size)", systemImage: "square.stack.3d.up.fill")
      .font(.subheadline.weight(.semibold))
      .foregroundStyle(ADEColor.accent)
    Text(stack.count > 1
      ? "GitHub merges the \(stack.count) open PRs up to this one together, or none of them."
      : "This is the bottom open PR of the stack. GitHub checks the branch rules during the merge.")
      .font(.footnote)
      .foregroundStyle(ADEColor.textSecondary)
      .fixedSize(horizontal: false, vertical: true)
    if isDraft {
      Text("Mark it ready for review before you merge the stack.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
    } else {
      Button {
        ADEHaptics.light()
        onStackMerge()
      } label: {
        Label(stack.count > 1 ? "Merge \(stack.count) PRs…" : "Merge…", systemImage: "arrow.triangle.merge")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .tint(ADEColor.success)
      .disabled(isBusy)
    }
  }

  @ViewBuilder
  private var cleanupSection: some View {
    if step.kind == .merged, isAvailable(.deleteBranch) {
      Button(role: .destructive) {
        onRun(.deleteBranch)
      } label: {
        Label("Delete lane and branch…", systemImage: "trash")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .tint(ADEColor.danger)
      .disabled(isBusy)
    }
    if step.kind == .closed, isAvailable(.reopen) {
      Button {
        onRun(.reopen)
      } label: {
        Text("Reopen").frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .disabled(isBusy)
    }
    Button {
      onArchiveLane()
    } label: {
      Label("Archive lane…", systemImage: "archivebox")
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.bordered)
    .controlSize(.large)
    .disabled(isBusy)
  }

  @ViewBuilder
  private func chipGlyph(_ state: PrRequirementChip.State) -> some View {
    switch state {
    case .pass:
      Image(systemName: "checkmark.circle.fill").foregroundStyle(ADEColor.success)
    case .fail:
      Image(systemName: "xmark.circle.fill").foregroundStyle(ADEColor.danger)
    case .pending:
      Image(systemName: "clock.fill").foregroundStyle(ADEColor.warning)
    case .neutral:
      Image(systemName: "minus.circle").foregroundStyle(ADEColor.textMuted)
    }
  }
}

/// Desktop's Comment card: a comment, or a review with its decision.
struct PrDuoCommentCard: View {
  let canReview: Bool
  let canComment: Bool
  let isBusy: Bool
  @Binding var draft: String
  let onComment: (String) -> Void
  let onReview: (PrReviewEventOption, String?) -> Void

  @State private var reviewing = false
  @State private var event: PrReviewEventOption = .approve
  @FocusState private var focused: Bool

  private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var canSend: Bool {
    guard !isBusy else { return false }
    if reviewing { return event == .approve || !trimmed.isEmpty }
    return canComment && !trimmed.isEmpty
  }

  var body: some View {
    PrDuoCard(dock: .comment, width: 380) {
      if canReview {
        Picker("Kind", selection: $reviewing) {
          Text("Comment").tag(false)
          Text("Review").tag(true)
        }
        .pickerStyle(.segmented)
      }
      if reviewing {
        Picker("Decision", selection: $event) {
          ForEach(PrReviewEventOption.allCases) { option in
            Text(option.title).tag(option)
          }
        }
        .pickerStyle(.segmented)
      }
      TextField(
        reviewing ? "Review summary (optional for an approval)" : "Leave a comment",
        text: $draft,
        axis: .vertical
      )
      .lineLimit(5...12)
      .font(.subheadline)
      .focused($focused)
      .padding(12)
      .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      HStack {
        Spacer()
        Button {
          if reviewing {
            onReview(event, trimmed.isEmpty ? nil : trimmed)
          } else {
            onComment(trimmed)
          }
          ADEHaptics.success()
        } label: {
          Label(isBusy ? "Sending…" : (reviewing ? "Submit review" : "Comment"), systemImage: "paperplane.fill")
        }
        .buttonStyle(.borderedProminent)
        .tint(ADEColor.accent)
        .disabled(!canSend)
      }
    }
    .onAppear { focused = true }
  }
}

/// Everyone whose review belongs on the Reviewers card: who was asked, then
/// who reviewed unasked, each with their latest opinion (desktop
/// `collectPrReviewers`).
struct PrDuoReviewer: Identifiable, Equatable {
  let login: String
  let avatarUrl: String?
  let isBot: Bool
  /// approved / changes_requested / commented, or nil when only requested.
  let state: String?
  let requested: Bool
  var id: String { PrAuthorIdentity.normalize(login) }
}

func prDuoReviewers(detail: PrDetail?, reviews: [PrReview]) -> [PrDuoReviewer] {
  var order: [String] = []
  var byLogin: [String: PrDuoReviewer] = [:]
  for user in detail?.requestedReviewers ?? [] {
    let key = PrAuthorIdentity.normalize(user.login)
    if byLogin[key] == nil { order.append(key) }
    byLogin[key] = PrDuoReviewer(
      login: user.login,
      avatarUrl: user.avatarUrl,
      isBot: PrAuthorIdentity.classify(user.login, accountIsBot: user.isBot).isBot,
      state: nil,
      requested: true
    )
  }
  let opinions = Dictionary(
    prLatestReviewOpinionByLogin(reviews).map { (PrAuthorIdentity.normalize($0.login), $0.state) },
    uniquingKeysWith: { _, last in last }
  )
  for review in reviews {
    let key = PrAuthorIdentity.normalize(review.reviewer)
    let existing = byLogin[key]
    if existing == nil { order.append(key) }
    let commented = review.state.lowercased() == "commented" || existing?.state == "commented"
    byLogin[key] = PrDuoReviewer(
      login: existing?.login ?? review.reviewer,
      avatarUrl: existing?.avatarUrl,
      isBot: (existing?.isBot ?? false) || PrAuthorIdentity.classify(review.reviewer, accountIsBot: review.reviewerIsBot).isBot,
      state: opinions[key] ?? (commented ? "commented" : existing?.state),
      requested: existing?.requested ?? false
    )
  }
  return order.compactMap { byLogin[$0] }
}

/// Desktop's Reviewers card: people and agents with their review state, and a
/// field to ask for more.
struct PrDuoReviewersCard: View {
  let reviewers: [PrDuoReviewer]
  let canRequest: Bool
  @Binding var draft: String
  let onRequest: ([String]) -> Void

  var body: some View {
    PrDuoCard(dock: .reviewers) {
      if reviewers.isEmpty {
        Text("No reviewers yet.")
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
      }
      group("People", reviewers.filter { !$0.isBot })
      group("Agents", reviewers.filter(\.isBot))
      HStack(spacing: 8) {
        TextField("Request: alice, bob", text: $draft)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .font(.subheadline)
          .onSubmit(submit)
          .padding(.horizontal, 12)
          .frame(height: 36)
          .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        Button("Request", action: submit)
          .buttonStyle(.bordered)
          .disabled(!canRequest || logins.isEmpty)
      }
    }
  }

  private var logins: [String] {
    draft.split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "@", with: "") }
      .filter { !$0.isEmpty }
  }

  private func submit() {
    guard canRequest, !logins.isEmpty else { return }
    onRequest(logins)
    draft = ""
  }

  @ViewBuilder
  private func group(_ title: String, _ entries: [PrDuoReviewer]) -> some View {
    if !entries.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
        PrDuoCardRows {
          ForEach(entries) { entry in
            HStack(spacing: 9) {
              PrAvatar(login: entry.login, isBot: entry.isBot, avatarUrl: entry.avatarUrl, size: 22)
              Text(entry.isBot ? PrAuthorIdentity.classify(entry.login, accountIsBot: true).displayName : entry.login)
                .font(.subheadline)
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(1)
              Spacer(minLength: 6)
              stateMark(entry)
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  private func stateMark(_ entry: PrDuoReviewer) -> some View {
    switch entry.state {
    case "approved":
      Label("Approved", systemImage: "checkmark.circle.fill")
        .labelStyle(.titleAndIcon)
        .font(.caption)
        .foregroundStyle(ADEColor.success)
    case "changes_requested":
      Label("Changes", systemImage: "exclamationmark.circle.fill")
        .font(.caption)
        .foregroundStyle(ADEColor.danger)
    case "dismissed":
      Text("Dismissed").font(.caption).foregroundStyle(ADEColor.textMuted)
    case "commented":
      Text("Commented").font(.caption).foregroundStyle(ADEColor.textMuted)
    default:
      Text(entry.requested ? "Requested" : "").font(.caption).foregroundStyle(ADEColor.textMuted)
    }
  }
}

/// Desktop's Labels card: the PR's labels, each removable, and a field to add.
struct PrDuoLabelsCard: View {
  let labels: [PrLabel]
  let canEdit: Bool
  @Binding var draft: String
  let onSet: ([String]) -> Void

  var body: some View {
    PrDuoCard(dock: .labels) {
      if labels.isEmpty {
        Text("No labels.")
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
      } else {
        LaneChipFlowLayout(spacing: 6, lineSpacing: 6) {
          ForEach(labels) { label in
            HStack(spacing: 5) {
              Circle()
                .fill(LaneColorPalette.color(forHex: label.color.hasPrefix("#") ? label.color : "#\(label.color)") ?? ADEColor.textMuted)
                .frame(width: 8, height: 8)
              Text(label.name)
                .font(.footnote.weight(.medium))
                .foregroundStyle(ADEColor.textPrimary)
              if canEdit {
                Button {
                  onSet(labels.map(\.name).filter { $0 != label.name })
                } label: {
                  Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(ADEColor.textMuted)
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove \(label.name)")
              }
            }
            .padding(.leading, 9)
            .padding(.trailing, canEdit ? 3 : 9)
            .frame(height: 26)
            .background(.fill.tertiary, in: Capsule(style: .continuous))
          }
        }
      }
      HStack(spacing: 8) {
        TextField("Add: bug, enhancement", text: $draft)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .font(.subheadline)
          .onSubmit(add)
          .padding(.horizontal, 12)
          .frame(height: 36)
          .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        Button("Add", action: add)
          .buttonStyle(.bordered)
          .disabled(!canEdit || additions.isEmpty)
      }
    }
  }

  private var additions: [String] {
    draft.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
  }

  private func add() {
    guard canEdit, !additions.isEmpty else { return }
    var names = labels.map(\.name)
    for name in additions where !names.contains(name) { names.append(name) }
    onSet(names)
    draft = ""
  }
}

/// Desktop's Assignees card.
struct PrDuoAssigneesCard: View {
  let assignees: [PrUser]

  var body: some View {
    PrDuoCard(dock: .assignees, width: 300) {
      if assignees.isEmpty {
        Text("No one assigned.")
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
      } else {
        PrDuoCardRows {
          ForEach(assignees) { user in
            HStack(spacing: 9) {
              PrAvatar(login: user.login, isBot: user.isBot, avatarUrl: user.avatarUrl, size: 22)
              Text(user.login)
                .font(.subheadline)
                .foregroundStyle(ADEColor.textPrimary)
              Spacer(minLength: 0)
            }
          }
        }
      }
    }
  }
}

/// Desktop's push rail: a slim glass capsule on the thread's trailing edge,
/// one tick per push. A tap scrolls the thread to that push; a long press
/// shows what the push was and the conversation it drew. A tick with open
/// threads is amber; one that drew conversation is longer.
struct PrPushTickRail: View {
  let ticks: [PrDigestPushTick]
  let activeId: String?
  /// An item of the Duo's edge bar: the bar draws the capsule, and the rail
  /// is a little wider to sit centred in it.
  var inBar = false
  let onSelect: (PrDigestPushTick) -> Void

  @State private var previewId: String?

  private var width: CGFloat { inBar ? 36 : 26 }

  var body: some View {
    let rail = ScrollView(.vertical, showsIndicators: false) {
      VStack(spacing: 2) {
        ForEach(ticks) { tick in
          tickButton(tick)
        }
      }
      .padding(.vertical, 8)
    }
    .scrollBounceBehavior(.basedOnSize)
    .frame(width: width, height: min(CGFloat(max(ticks.count, 1)) * 14 + 16, inBar ? 250 : 320))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Pushes")
    if inBar {
      rail
    } else {
      rail.glassEffect(.regular, in: Capsule(style: .continuous))
    }
  }

  private func tickButton(_ tick: PrDigestPushTick) -> some View {
    let active = tick.id == activeId
    let talked = tick.commentCount > 0
    let tone: Color = tick.openCount > 0
      ? ADEColor.warning
      : active ? ADEColor.accent : ADEColor.textPrimary.opacity(talked ? 0.55 : 0.25)
    return Capsule(style: .continuous)
      .fill(tone)
      .frame(width: active ? 13 : talked ? 10 : 6, height: 3)
      .frame(width: width, height: 12)
      .contentShape(Rectangle())
      .onTapGesture {
        ADEHaptics.light()
        onSelect(tick)
      }
      .onLongPressGesture(minimumDuration: 0.35) {
        ADEHaptics.light()
        previewId = tick.id
      }
      .popover(isPresented: Binding(
        get: { previewId == tick.id },
        set: { if !$0, previewId == tick.id { previewId = nil } }
      ), arrowEdge: .trailing) {
        PrPushTickPreview(tick: tick)
          .presentationCompactAdaptation(.popover)
      }
      .accessibilityElement()
      .accessibilityLabel("Push \(tick.push.shortSha): \(tick.push.subject)")
      .accessibilityAddTraits(.isButton)
      .accessibilityAction { onSelect(tick) }
  }
}

/// What a push tick says on a long press: the push, when, and its talk.
struct PrPushTickPreview: View {
  let tick: PrDigestPushTick

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 5) {
        Text(verbatim: tick.push.shortSha)
          .font(.adeMono(11, weight: .medium))
          .foregroundStyle(ADEColor.accent)
        Text("· \(prCompactRelativeTime(tick.push.at))")
        if tick.push.commitCount > 1 {
          Text("· \(tick.push.commitCount) commits")
        }
        if tick.push.forcePushed {
          Text("· force-pushed")
        }
      }
      .font(.caption)
      .foregroundStyle(ADEColor.textMuted)
      Text(tick.push.subject)
        .font(.subheadline.weight(.medium))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
      Text(tick.commentCount == 0
        ? "No comments"
        : "\(tick.commentCount) comment\(tick.commentCount == 1 ? "" : "s")\(tick.openCount > 0 ? " · \(tick.openCount) open" : "")")
        .font(.caption)
        .foregroundStyle(tick.openCount > 0 ? ADEColor.warning : ADEColor.textMuted)
    }
    .padding(14)
    .frame(width: 260, alignment: .leading)
  }
}
