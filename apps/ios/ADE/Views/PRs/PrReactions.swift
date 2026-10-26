import SwiftUI

// Reactions on the PR description and its conversation comments, the phone's
// counterpart of the desktop's `PrReactionBar`: one pill per reaction with its
// count, yours tinted, and a + that offers GitHub's eight. Adding shows at
// once and is taken back if GitHub refuses it. GitHub's add is idempotent and
// the host has no remove, so a reaction you already gave is a reading, not a
// toggle (the desktop draws it the same way).

/// GitHub's reaction contents, in GitHub's own picker order.
let prReactionOptions: [(content: String, emoji: String, name: String)] = [
  ("+1", "👍", "Thumbs up"),
  ("-1", "👎", "Thumbs down"),
  ("laugh", "😄", "Laugh"),
  ("hooray", "🎉", "Hooray"),
  ("confused", "😕", "Confused"),
  ("heart", "❤️", "Heart"),
  ("rocket", "🚀", "Rocket"),
  ("eyes", "👀", "Eyes"),
]

func prReactionEmoji(_ content: String) -> String? {
  prReactionOptions.first { $0.content == content }?.emoji
}

/// One pill: a content and how many people gave it. Contents this build does
/// not know are dropped rather than drawn as raw words.
struct PrReactionTally: Equatable, Identifiable {
  var id: String { content }
  let content: String
  let count: Int
  let mine: Bool
}

/// Folds GitHub's rollups (one entry per user, or one synthetic entry with an
/// exact `count`) into pills, in picker order.
func prReactionTallies(_ reactions: [PrReviewThreadReaction], viewerLogin: String?) -> [PrReactionTally] {
  let viewer = viewerLogin?.lowercased()
  var counts: [String: Int] = [:]
  var mine: Set<String> = []
  for reaction in reactions {
    counts[reaction.content, default: 0] += max(reaction.count ?? 1, 0)
    if let viewer, reaction.user.lowercased() == viewer { mine.insert(reaction.content) }
  }
  return prReactionOptions.compactMap { option in
    guard let count = counts[option.content], count > 0 else { return nil }
    return PrReactionTally(content: option.content, count: count, mine: mine.contains(option.content))
  }
}

/// What the Overview needs to offer reactions and edits, decided once by the
/// detail screen.
struct PrConversationControls: Equatable {
  /// The account edits and reactions are made as. Nil until the host has said.
  var viewerLogin: String?
  var canReact = false
  var canEditComments = false
  /// The PR's own node id, for reactions on the description.
  var descriptionSubjectId: String?
  var descriptionReactions: [PrReviewThreadReaction] = []

  static let none = PrConversationControls()

  /// Whether `entry` is a comment this account wrote and the host can edit.
  func canEdit(_ entry: PrDigestEntry) -> Bool {
    guard canEditComments, entry.commentGithubId != nil, let viewerLogin, !viewerLogin.isEmpty else { return false }
    return entry.author.lowercased() == viewerLogin.lowercased()
  }
}

struct PrReactionBar: View {
  /// Changes when the bar is reused for another PR or comment, which drops
  /// any optimistic state that belonged to the old one.
  let subjectKey: String
  let reactions: [PrReviewThreadReaction]
  let viewerLogin: String?
  let canReact: Bool
  let onReact: (_ content: String) async throws -> Void
  var onError: (Error) -> Void = { _ in }

  @State private var local: [PrReviewThreadReaction] = []
  @State private var seededKey: String?
  @State private var pending = 0

  private var shown: [PrReviewThreadReaction] { seededKey == subjectKey ? local : reactions }

  var body: some View {
    let tallies = prReactionTallies(shown, viewerLogin: viewerLogin)
    if canReact || !tallies.isEmpty {
      HStack(spacing: 6) {
        ForEach(tallies) { tally in
          pill(tally)
        }
        if canReact {
          Menu {
            ForEach(prReactionOptions, id: \.content) { option in
              Button("\(option.emoji)  \(option.name)") { add(option.content) }
            }
          } label: {
            Image(systemName: "face.smiling")
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
              .frame(width: 30, height: 24)
              .background(ADEKit.track, in: Capsule(style: .continuous))
              .contentShape(Capsule(style: .continuous))
          }
          .accessibilityLabel("Add reaction")
        }
      }
      .onAppear(perform: seedIfNeeded)
      .onChange(of: subjectKey) { _, _ in
        pending = 0
        seededKey = nil
        seedIfNeeded()
      }
      .onChange(of: reactions) { _, fresh in
        // A reload replaces the optimistic copy only once nothing is in
        // flight: an older read must not erase a reaction being added.
        if pending == 0 { local = fresh }
      }
    }
  }

  @ViewBuilder
  private func pill(_ tally: PrReactionTally) -> some View {
    let label = HStack(spacing: 4) {
      Text(prReactionEmoji(tally.content) ?? "")
        .font(.system(size: 12))
      Text("\(tally.count)")
        .font(.caption2.weight(.semibold).monospacedDigit())
        .foregroundStyle(tally.mine ? ADEColor.accent : ADEColor.textSecondary)
    }
    .padding(.horizontal, 8)
    .frame(height: 24)
    .background(tally.mine ? ADEColor.accent.opacity(0.14) : ADEKit.track, in: Capsule(style: .continuous))
    .overlay(
      Capsule(style: .continuous)
        .stroke(tally.mine ? ADEColor.accent.opacity(0.45) : .clear, lineWidth: 0.8)
    )
    .contentShape(Capsule(style: .continuous))
    let name = prReactionOptions.first { $0.content == tally.content }?.name ?? tally.content
    if canReact && !tally.mine {
      Button { add(tally.content) } label: { label }
        .buttonStyle(.plain)
        .accessibilityLabel("\(name), \(tally.count). Add yours")
    } else {
      label
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(tally.mine ? "\(name), \(tally.count), including you" : "\(name), \(tally.count)")
    }
  }

  private func seedIfNeeded() {
    guard seededKey != subjectKey else { return }
    local = reactions
    seededKey = subjectKey
  }

  private func add(_ content: String) {
    guard canReact, let viewerLogin, !viewerLogin.isEmpty else { return }
    seedIfNeeded()
    let viewer = viewerLogin.lowercased()
    guard !local.contains(where: { $0.content == content && $0.user.lowercased() == viewer }) else { return }
    ADEHaptics.light()
    let optimisticId = "optimistic:\(subjectKey):\(content):\(UUID().uuidString)"
    let key = subjectKey
    local.append(PrReviewThreadReaction(id: optimisticId, content: content, user: viewerLogin))
    pending += 1
    Task { @MainActor in
      do {
        try await onReact(content)
      } catch {
        if seededKey == key { local.removeAll { $0.id == optimisticId } }
        onError(error)
      }
      if seededKey == key { pending = max(0, pending - 1) }
    }
  }
}
