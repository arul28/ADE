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

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title)
        .font(.title3.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
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
