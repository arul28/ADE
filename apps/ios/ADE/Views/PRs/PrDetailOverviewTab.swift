import SwiftUI
import UIKit

// MARK: - Overview thread row components (desktop Timeline+Rails parity)
//
// The Overview tab used to render ONE monolithic `PrUnifiedOverviewThread`
// view inside a single List row, which defeated list virtualization and was
// the primary source of scroll lag on long PRs. It is now a set of standalone
// row components that `PrDetailScreen.overviewThreadRows` emits as SIBLING
// List rows:
//
//   unmapped banner → AI summary → description → chronological event feed →
//   review threads → composer → merge rail (with requirement checklist) →
//   metadata cards (checks / commits / files / people / stack / cleanup).
//
// All surfaces use the flat adaptive PR tokens (`PrGlassPalette` /
// `prGlassCard`) — no materials, no blend modes, no blur.

/// Uppercase section header row used between thread segments.
struct PrThreadSectionHeader: View {
  let title: String
  var trailing: String?

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(title.uppercased())
        .font(.system(size: 10, weight: .bold))
        .tracking(1.0)
        .foregroundStyle(ADEColor.textSecondary)
      Spacer(minLength: 8)
      if let trailing {
        Text(trailing)
          .font(.system(size: 11, weight: .semibold, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 4)
  }
}

/// PR description rendered as the first card of the thread.
struct PrThreadDescriptionCard: View {
  let author: String?
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Image(systemName: "text.alignleft")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.accent)
        Text("DESCRIPTION")
          .font(.system(size: 10, weight: .bold))
          .tracking(1.0)
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 0)
        if let author, !author.isEmpty {
          Text("@\(author)")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      PrInlineCodeText(text: text)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 16)
  }
}

/// Amber banner shown at the top of the thread when the PR is not mapped to an
/// ADE lane. Primary action is auto-map ("Create lane from PR branch", gated on
/// host support); the secondary action opens the PR on GitHub. (Linking to an
/// existing lane lives on the root unmapped-PR sheet.)
struct PrUnmappedThreadBanner: View {
  let canAutoMap: Bool
  let onAutoMap: () -> Void
  let onOpenInGitHub: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "exclamationmark.triangle.fill")
          .font(.system(size: 14))
          .foregroundStyle(ADEColor.warning)
          .padding(.top, 1)
        VStack(alignment: .leading, spacing: 3) {
          Text("Not mapped to a lane")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("Create a lane from this PR's branch to track and act on it inside ADE.")
            .font(.system(size: 11.5))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
      }

      HStack(spacing: 8) {
        if canAutoMap {
          Button(action: onAutoMap) {
            Label("Create lane from PR branch", systemImage: "arrow.triangle.branch")
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(.white)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 9)
              .background(ADEColor.accentDeep, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
          }
          .buttonStyle(.plain)
        }
        Button(action: onOpenInGitHub) {
          Label("Open in GitHub", systemImage: "arrow.up.right.square")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
            .frame(maxWidth: canAutoMap ? nil : .infinity)
            .padding(.horizontal, canAutoMap ? 12 : 0)
            .padding(.vertical, 9)
            .background(
              RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(ADEColor.accent.opacity(0.12))
            )
            .overlay(
              RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(ADEColor.accent.opacity(0.35), lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 16, tint: ADEColor.warning, shadow: false)
  }
}

/// Locked comment composer shown when the PR is unmapped (desktop parity).
struct PrLockedComposerBar: View {
  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "lock.fill")
        .font(.system(size: 13))
        .foregroundStyle(ADEColor.textMuted)
      Text("Map this PR to a lane to comment")
        .font(.system(size: 12))
        .foregroundStyle(ADEColor.textSecondary)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .fill(PrGlassPalette.threadCard)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .strokeBorder(PrGlassPalette.cardBorder, lineWidth: 0.5)
    )
  }
}

// MARK: - Inline merge rail (unified thread bottom)

/// Drives the inline merge rail at the bottom of the unified Overview thread.
/// Mirrors desktop's `PrDetailMergeRail`: terminal states, the requirement
/// checklist, a merge split-button, a close action, and a copyable
/// command-line instruction.
struct PrOverviewMergeRailModel {
  enum Phase {
    case merged
    case closed
    case active
  }

  let phase: Phase
  let repoOwner: String
  let repoName: String
  let prNumber: Int
  /// Merge-gate summary (green/amber/red) for the active state.
  let gate: PrMergeGateInfo
  let isDraft: Bool
  let canMerge: Bool
  let canClose: Bool
  let canDeleteBranch: Bool
  let canReopen: Bool
  let isBusy: Bool
  let mergeMethod: PrMergeMethodOption

  let onMerge: () -> Void
  let onChangeMethod: () -> Void
  let onClose: () -> Void
  let onReopen: () -> Void
  let onDeleteBranch: () -> Void

  var commandLine: String {
    "gh -R \(repoOwner)/\(repoName) pr merge \(prNumber) --\(mergeMethod.rawValue)"
  }
}

struct PrOverviewMergeRail: View {
  let model: PrOverviewMergeRailModel
  /// GitHub-style requirement rows (desktop `buildMergeChecklist` parity).
  var checklist: [PrMergeChecklistItem] = []

  @State private var showCommandLine = false
  @State private var confirmClose = false
  @State private var confirmDelete = false
  @State private var copiedCommand = false

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      PrEyebrow(text: "Merge", tint: ADEColor.textSecondary)

      switch model.phase {
      case .merged:
        mergedSection
      case .closed:
        closedSection
      case .active:
        activeSection
      }
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .prGlassCard(cornerRadius: 18)
  }

  // MARK: Terminal: merged

  private var mergedSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      statusLine(icon: "checkmark.seal.fill", tint: ADEColor.success, title: "Merged and closed")
      if model.canDeleteBranch {
        if confirmDelete {
          confirmRow(
            message: "Delete the branch?",
            confirmTitle: "Delete branch",
            tint: ADEColor.danger,
            onConfirm: { confirmDelete = false; model.onDeleteBranch() },
            onCancel: { confirmDelete = false }
          )
        } else {
          secondaryButton(title: "Delete branch", icon: "trash", tint: ADEColor.danger) {
            confirmDelete = true
          }
        }
      }
    }
  }

  // MARK: Terminal: closed

  private var closedSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      statusLine(icon: "xmark.circle.fill", tint: ADEColor.danger, title: "This PR is closed")
      if model.canReopen {
        secondaryButton(title: "Reopen pull request", icon: "arrow.uturn.up", tint: ADEColor.accent) {
          model.onReopen()
        }
      }
    }
  }

  // MARK: Active (open / draft)

  private var activeSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      // Mergeability status line (desktop checklist header pill).
      switch model.gate.tone {
      case .green:
        statusLine(icon: "checkmark.seal.fill", tint: ADEColor.success, title: "Ready to merge")
      case .amber:
        statusLine(icon: "clock.fill", tint: ADEColor.warning, title: model.isDraft ? "Draft — not ready" : "Checking…")
      case .red:
        statusLine(icon: "exclamationmark.octagon.fill", tint: ADEColor.danger, title: "Merging is blocked")
      }

      // Requirement checklist (review / checks / conflicts / behind / rules).
      if !checklist.isEmpty {
        PrMergeChecklistView(items: checklist)
      }

      // Merge split-button (primary action + method menu).
      HStack(spacing: 8) {
        Button {
          if model.canMerge && !model.isBusy { model.onMerge() }
        } label: {
          HStack(spacing: 8) {
            if model.isBusy {
              ProgressView().controlSize(.small).tint(.white)
            } else {
              Image(systemName: "arrow.triangle.merge")
                .font(.system(size: 13, weight: .bold))
            }
            Text(model.mergeMethod.shortTitle)
              .font(.system(size: 14, weight: .bold))
          }
          .foregroundStyle(.white)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 13)
          .background(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
              .fill(ADEColor.success)
          )
          .opacity(model.canMerge && !model.isBusy ? 1 : 0.5)
        }
        .buttonStyle(.plain)
        .disabled(!model.canMerge || model.isBusy)

        Button(action: model.onChangeMethod) {
          Image(systemName: "chevron.up.chevron.down")
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 44, height: 46)
            .background(
              RoundedRectangle(cornerRadius: 13, style: .continuous)
                .fill(ADEColor.recessedBackground)
            )
            .overlay(
              RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(PrGlassPalette.cardBorder, lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Change merge method")
      }

      // Close pull request (two-tap confirm).
      if model.canClose {
        if confirmClose {
          confirmRow(
            message: "Close this PR?",
            confirmTitle: "Close PR",
            tint: ADEColor.danger,
            onConfirm: { confirmClose = false; model.onClose() },
            onCancel: { confirmClose = false }
          )
        } else {
          secondaryButton(title: "Close pull request", icon: "xmark.circle", tint: ADEColor.danger) {
            confirmClose = true
          }
        }
      }

      // Command-line instructions disclosure.
      commandLineDisclosure
    }
  }

  // MARK: Pieces

  private func statusLine(icon: String, tint: Color, title: String) -> some View {
    HStack(spacing: 9) {
      Image(systemName: icon)
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(tint)
      Text(title)
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(tint)
      Spacer(minLength: 0)
    }
  }

  private func secondaryButton(title: String, icon: String, tint: Color, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 7) {
        Image(systemName: icon).font(.system(size: 12, weight: .semibold))
        Text(title).font(.system(size: 13, weight: .semibold))
        Spacer(minLength: 0)
      }
      .foregroundStyle(tint)
      .padding(.horizontal, 13)
      .padding(.vertical, 11)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(tint.opacity(0.10))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(tint.opacity(0.30), lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)
  }

  private func confirmRow(
    message: String,
    confirmTitle: String,
    tint: Color,
    onConfirm: @escaping () -> Void,
    onCancel: @escaping () -> Void
  ) -> some View {
    HStack(spacing: 8) {
      Text(message)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Spacer(minLength: 0)
      Button("Cancel", action: onCancel)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .buttonStyle(.plain)
      Button(confirmTitle, action: onConfirm)
        .font(.system(size: 12, weight: .bold))
        .foregroundStyle(tint)
        .buttonStyle(.plain)
    }
    .padding(.horizontal, 13)
    .padding(.vertical, 11)
    .background(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(tint.opacity(0.10))
    )
  }

  private var commandLineDisclosure: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) { showCommandLine.toggle() }
      } label: {
        HStack(spacing: 6) {
          Image(systemName: showCommandLine ? "chevron.down" : "chevron.right")
            .font(.system(size: 9, weight: .bold))
          Text("View command line instructions")
            .font(.system(size: 11.5, weight: .medium))
          Spacer(minLength: 0)
        }
        .foregroundStyle(ADEColor.textMuted)
      }
      .buttonStyle(.plain)

      if showCommandLine {
        HStack(spacing: 8) {
          Text(model.commandLine)
            .font(.system(size: 11.5, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer(minLength: 0)
          Button {
            UIPasteboard.general.string = model.commandLine
            copiedCommand = true
            ADEHaptics.success()
          } label: {
            Image(systemName: copiedCommand ? "checkmark" : "doc.on.doc")
              .font(.system(size: 11, weight: .semibold))
              .foregroundStyle(copiedCommand ? ADEColor.success : ADEColor.textSecondary)
          }
          .buttonStyle(.plain)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .background(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(ADEColor.recessedBackground)
        )
      }
    }
  }
}

// MARK: - Check group summary

struct PrOverviewCheckGroup: Identifiable, Equatable {
  let id: String
  let name: String
  let pass: Int
  let fail: Int
  let pending: Int

  var total: Int { pass + fail + pending }

  var dotColor: Color {
    if fail > 0 { return ADEColor.danger }
    if pending > 0 { return ADEColor.warning }
    return ADEColor.success
  }
}

private struct PrOverviewCheckRow: View {
  let group: PrOverviewCheckGroup
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      HStack(spacing: 10) {
        Circle()
          .fill(group.dotColor)
          .frame(width: 8, height: 8)
        Text(group.name)
          .font(.system(size: 12.5, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
        Text("\(group.pass)/\(group.total) passing")
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 11)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

/// Buckets individual `PrCheck`s into the four visual groups used on Overview.
/// Heuristics: name prefix `bot`/`[bot]` or bot-like suffix → Bots; names
/// containing `security`/`codeql`/`snyk`/`trivy` → Security; otherwise → CI.
func prGroupChecks(_ checks: [PrCheck]) -> [PrOverviewCheckGroup] {
  guard !checks.isEmpty else { return [] }

  var ci: (p: Int, f: Int, pnd: Int) = (0, 0, 0)
  var bots: (p: Int, f: Int, pnd: Int) = (0, 0, 0)
  var security: (p: Int, f: Int, pnd: Int) = (0, 0, 0)
  var other: (p: Int, f: Int, pnd: Int) = (0, 0, 0)

  for check in checks {
    let bucket = prCheckBucket(check.name)
    let outcome = prCheckOutcome(check)
    switch bucket {
    case .ci:
      if outcome == .pass { ci.p += 1 } else if outcome == .fail { ci.f += 1 } else { ci.pnd += 1 }
    case .bots:
      if outcome == .pass { bots.p += 1 } else if outcome == .fail { bots.f += 1 } else { bots.pnd += 1 }
    case .security:
      if outcome == .pass { security.p += 1 } else if outcome == .fail { security.f += 1 } else { security.pnd += 1 }
    case .other:
      if outcome == .pass { other.p += 1 } else if outcome == .fail { other.f += 1 } else { other.pnd += 1 }
    }
  }

  var groups: [PrOverviewCheckGroup] = []
  if ci.p + ci.f + ci.pnd > 0 { groups.append(PrOverviewCheckGroup(id: "CI", name: "CI", pass: ci.p, fail: ci.f, pending: ci.pnd)) }
  if bots.p + bots.f + bots.pnd > 0 { groups.append(PrOverviewCheckGroup(id: "Bots", name: "Bots", pass: bots.p, fail: bots.f, pending: bots.pnd)) }
  if security.p + security.f + security.pnd > 0 { groups.append(PrOverviewCheckGroup(id: "Security", name: "Security", pass: security.p, fail: security.f, pending: security.pnd)) }
  if other.p + other.f + other.pnd > 0 { groups.append(PrOverviewCheckGroup(id: "Other", name: "Other", pass: other.p, fail: other.f, pending: other.pnd)) }
  return groups
}

private enum PrCheckBucket { case ci, bots, security, other }
private enum PrCheckOutcome { case pass, fail, pending }

private func prCheckBucket(_ name: String) -> PrCheckBucket {
  let lowered = name.lowercased()
  if lowered.contains("[bot]") || lowered.contains("bot:") || lowered.contains("coderabbit") || lowered.contains("greptile") || lowered.contains("codecov") || lowered.contains("sourcery") {
    return .bots
  }
  if lowered.contains("security") || lowered.contains("codeql") || lowered.contains("snyk") || lowered.contains("trivy") || lowered.contains("dependabot") {
    return .security
  }
  if lowered.contains("ci") || lowered.contains("test") || lowered.contains("lint") || lowered.contains("build") || lowered.contains("typecheck") {
    return .ci
  }
  return .other
}

private func prCheckOutcome(_ check: PrCheck) -> PrCheckOutcome {
  if check.status != "completed" {
    return .pending
  }
  switch check.conclusion {
  case "success", "neutral", "skipped":
    return .pass
  case nil:
    return .pending
  default:
    return .fail
  }
}

// MARK: - Metadata cards (desktop right rail, stacked)

/// Checks summary card — grouped CI/Bots/Security rows, tap → Checks tab.
struct PrOverviewChecksCard: View {
  let checks: [PrCheck]
  let onSeeAll: () -> Void

  var body: some View {
    let groups = prGroupChecks(checks)
    VStack(alignment: .leading, spacing: 10) {
      PrSectionHdr(title: "Checks") {
        Text("\(checks.count) check\(checks.count == 1 ? "" : "s")")
      }
      VStack(spacing: 0) {
        ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
          PrOverviewCheckRow(group: group, onTap: onSeeAll)
          if index < groups.count - 1 {
            Divider()
              .background(PrGlassPalette.cardBorder)
          }
        }
      }
    }
    .padding(.bottom, 4)
    .prGlassCard(cornerRadius: 16)
  }
}

/// Commits card — vertical rail of the most recent commits (desktop left rail).
struct PrOverviewCommitsCard: View {
  let commits: [PrCommit]

  var body: some View {
    let entries: [PrCommitRailEntry] = commits.prefix(8).map { commit in
      PrCommitRailEntry(
        id: commit.id,
        sha: commit.sha,
        message: commit.message,
        author: commit.authorLogin ?? commit.authorName,
        timestampIso: commit.committedDate,
        checksState: commit.checkStatus ?? "none"
      )
    }
    VStack(alignment: .leading, spacing: 0) {
      PrSectionHdr(title: "Commits") {
        Text(commits.count == 1 ? "1 commit" : "\(commits.count) commits")
      }
      PrCommitRailView(commits: entries)
    }
    .padding(.bottom, 4)
    .prGlassCard(cornerRadius: 16)
  }
}

/// Files-changed card — top files with +/- counts, tap → Files tab.
struct PrOverviewFilesCard: View {
  let files: [PrFile]
  let onSeeAll: () -> Void

  var body: some View {
    let additions = files.reduce(0) { $0 + $1.additions }
    let deletions = files.reduce(0) { $0 + $1.deletions }
    let top = Array(files.prefix(4))
    VStack(alignment: .leading, spacing: 0) {
      PrSectionHdr(title: "Files") {
        Text("+\(additions) / −\(deletions)")
      }
      ForEach(Array(top.enumerated()), id: \.element.id) { index, file in
        PrOverviewFileRow(file: file)
        if index < top.count - 1 || files.count > top.count {
          Divider()
            .background(PrGlassPalette.cardBorder)
        }
      }
      if files.count > top.count {
        Button(action: onSeeAll) {
          Text("+ \(files.count - top.count) more files")
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(ADEColor.accent)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
        }
        .buttonStyle(.plain)
      }
    }
    .padding(.bottom, 4)
    .prGlassCard(cornerRadius: 16)
  }
}

/// People card — author, reviewers with state, labels, assignees, and linked
/// issues (desktop right-rail People + Development cards).
struct PrOverviewPeopleCard: View {
  let detail: PrDetail?
  let reviews: [PrReview]
  let authorLogin: String?

  private struct ReviewerEntry: Identifiable {
    let id: String
    let login: String
    let stateLabel: String
    let stateTint: Color
  }

  private var reviewerEntries: [ReviewerEntry] {
    // A requested reviewer may already have a submitted review (re-request,
    // stale request list) — the submitted state must win over "pending".
    var latestReviewByReviewer: [String: PrReview] = [:]
    for review in reviews where prBotProvider(from: review.reviewer) == nil {
      latestReviewByReviewer[review.reviewer] = review
    }

    func reviewedEntry(_ review: PrReview) -> ReviewerEntry {
      switch review.state {
      case "approved":
        return ReviewerEntry(id: "rev-\(review.reviewer)", login: review.reviewer, stateLabel: "approved", stateTint: ADEColor.success)
      case "changes_requested":
        return ReviewerEntry(id: "rev-\(review.reviewer)", login: review.reviewer, stateLabel: "changes", stateTint: ADEColor.danger)
      default:
        return ReviewerEntry(id: "rev-\(review.reviewer)", login: review.reviewer, stateLabel: "commented", stateTint: ADEColor.textSecondary)
      }
    }

    var seen = Set<String>()
    var entries: [ReviewerEntry] = []
    for user in detail?.requestedReviewers ?? [] where seen.insert(user.login).inserted {
      if let review = latestReviewByReviewer[user.login] {
        entries.append(reviewedEntry(review))
      } else {
        entries.append(ReviewerEntry(id: "req-\(user.login)", login: user.login, stateLabel: "pending", stateTint: ADEColor.warning))
      }
    }
    for review in reviews {
      // Dict membership doubles as the bot filter — only human reviewers were indexed.
      guard let latest = latestReviewByReviewer[review.reviewer],
            seen.insert(review.reviewer).inserted else { continue }
      entries.append(reviewedEntry(latest))
    }
    return entries
  }

  var body: some View {
    let labels = detail?.labels ?? []
    let assignees = detail?.assignees ?? []
    let linkedIssues = detail?.linkedIssues ?? []
    let reviewers = reviewerEntries

    VStack(alignment: .leading, spacing: 0) {
      PrSectionHdr(title: "People")

      if let authorLogin, !authorLogin.isEmpty {
        peopleRow(login: authorLogin, roleLabel: "author", roleTint: ADEColor.textSecondary)
      }
      ForEach(reviewers) { reviewer in
        peopleRow(login: reviewer.login, roleLabel: reviewer.stateLabel, roleTint: reviewer.stateTint)
      }
      ForEach(assignees) { assignee in
        peopleRow(login: assignee.login, roleLabel: "assignee", roleTint: ADEColor.info)
      }

      if !labels.isEmpty {
        Divider().background(PrGlassPalette.cardBorder)
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            ForEach(labels) { label in
              let tint = prLabelColor(label.color)
              Text(label.name)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(tint)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Capsule(style: .continuous).fill(tint.opacity(0.14)))
                .overlay(Capsule(style: .continuous).strokeBorder(tint.opacity(0.35), lineWidth: 0.5))
            }
          }
          .padding(.horizontal, 14)
        }
        .padding(.vertical, 10)
      }

      if !linkedIssues.isEmpty {
        Divider().background(PrGlassPalette.cardBorder)
        ForEach(linkedIssues) { issue in
          HStack(spacing: 8) {
            Image(systemName: issue.state == "closed" ? "checkmark.circle" : "smallcircle.filled.circle")
              .font(.system(size: 11))
              .foregroundStyle(issue.state == "closed" ? ADEColor.accent : ADEColor.success)
            Text("#\(issue.number)")
              .font(.system(size: 11, weight: .semibold, design: .monospaced))
              .foregroundStyle(ADEColor.textSecondary)
            Text(issue.title)
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
        }
      }
    }
    .padding(.bottom, 6)
    .prGlassCard(cornerRadius: 16)
  }

  private func peopleRow(login: String, roleLabel: String, roleTint: Color) -> some View {
    HStack(spacing: 10) {
      ZStack {
        Circle().fill(ADEColor.accent.opacity(0.14))
        Circle().strokeBorder(ADEColor.accent.opacity(0.3), lineWidth: 0.5)
        Text(String(login.prefix(1)).uppercased())
          .font(.system(size: 10, weight: .heavy))
          .foregroundStyle(ADEColor.accent)
      }
      .frame(width: 24, height: 24)
      Text(login)
        .font(.system(size: 12.5, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      Spacer(minLength: 8)
      PrTagChip(label: roleLabel, color: roleTint)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 7)
  }
}

/// Parses a GitHub label hex string (e.g. "d73a4a") into a Color; falls back
/// to the accent for malformed values.
func prLabelColor(_ hex: String) -> Color {
  var value: UInt64 = 0
  let cleaned = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
  guard cleaned.count == 6, Scanner(string: cleaned).scanHexInt64(&value) else {
    return ADEColor.accent
  }
  return Color(
    red: Double((value >> 16) & 0xFF) / 255,
    green: Double((value >> 8) & 0xFF) / 255,
    blue: Double(value & 0xFF) / 255
  )
}

/// Stack card — sibling PRs in the same lane chain.
struct PrOverviewStackCard: View {
  let groupMembers: [PrGroupMemberSummary]
  let groupId: String
  let laneName: String?
  let isLive: Bool
  let onOpenStack: (String, String?) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      PrSectionHdr(title: "Stack") {
        Text("\(groupMembers.count) PRs")
      }

      VStack(alignment: .leading, spacing: 8) {
        ForEach(groupMembers) { member in
          HStack(spacing: 10) {
            Text("\(member.position + 1)")
              .font(.caption.weight(.bold))
              .foregroundStyle(ADEColor.accent)
              .frame(width: 22, height: 22)
              .background(ADEColor.accent.opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
              Text(member.title)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(1)
              Text("#\(member.githubPrNumber) · \(member.headBranch) → \(member.baseBranch)")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
            }
          }
        }

        Button("Open stack") {
          onOpenStack(groupId, laneName)
        }
        .buttonStyle(.glass)
        .disabled(!isLive)
      }
      .padding(.horizontal, 14)
      .padding(.bottom, 12)
    }
    .prGlassCard(cornerRadius: 16)
  }
}

// MARK: - File row

private struct PrOverviewFileRow: View {
  let file: PrFile

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "doc")
        .font(.system(size: 13))
        .foregroundStyle(ADEColor.textMuted)
      Text(file.filename)
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .truncationMode(.middle)
      Spacer(minLength: 0)
      if file.status == "added" {
        PrOverviewInlineChip(text: "new", tint: ADEColor.success)
      } else if file.status == "removed" {
        PrOverviewInlineChip(text: "del", tint: ADEColor.danger)
      } else if file.status == "renamed" {
        PrOverviewInlineChip(text: "ren", tint: ADEColor.accent)
      }
      Text("+\(file.additions)")
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(ADEColor.success)
      Text("−\(file.deletions)")
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(ADEColor.danger)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
  }
}

private struct PrOverviewInlineChip: View {
  let text: String
  let tint: Color

  var body: some View {
    Text(text)
      .font(.system(size: 9, weight: .bold))
      .tracking(0.5)
      .foregroundStyle(tint)
      .padding(.horizontal, 5)
      .padding(.vertical, 2)
      .background(
        Capsule(style: .continuous)
          .fill(tint.opacity(0.14))
      )
      .overlay(
        Capsule(style: .continuous)
          .strokeBorder(tint.opacity(0.35), lineWidth: 0.5)
      )
  }
}

// MARK: - Shared helpers retained
//
// `PrDetailSectionCard` is shared with `PrDetailChecksTab`; `PrLaneCleanupBanner`
// is emitted by the Overview thread for merged PRs.

struct PrDetailSectionCard<Content: View>: View {
  let title: String
  let content: Content

  init(_ title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      content
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

struct PrLaneCleanupBanner: View {
  let laneName: String?
  let isLive: Bool
  let onArchive: () -> Void
  let onDeleteBranch: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "trash.circle.fill")
          .foregroundStyle(ADEColor.warning)
        VStack(alignment: .leading, spacing: 4) {
          Text("Lane cleanup")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("\(laneName ?? "This lane") merged successfully. Clean it up now to archive it or delete its branch.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }

      HStack(spacing: 10) {
        Button("Archive lane") {
          onArchive()
        }
        .buttonStyle(.glass)
        .disabled(!isLive)

        Button("Delete branch", role: .destructive) {
          onDeleteBranch()
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.warning)
        .disabled(!isLive)
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}
