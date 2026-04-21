import SwiftUI

/// Rebase attention screen — shown when a lane has drifted behind its target.
/// Presented via NavigationLink from `PrMobileWorkflowCardView`'s rebase
/// section; also reachable from the PR detail sticky action bar when a
/// rebase is needed.
struct PrRebaseScreen: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let laneId: String
  let laneName: String?
  let prNumber: Int?
  let prId: String?
  let behindCount: Int
  let conflictPredicted: Bool
  let branchRef: String?
  let baseBranch: String?
  /// Real commits from the host. When populated, supersedes the synthetic
  /// preview rows. Empty/nil falls back to the synthetic path.
  let targetCommits: [RebaseTargetCommit]?
  /// Host-resolved rebase mode for the lane's most-recent open/draft PR.
  /// "manual" → PR carries an immutable base (lane_base) so auto-rebase is
  /// suppressed; "auto" (or nil on older hosts) → PR tracks upstream base.
  let rebaseMode: String?
  /// Raw creation strategy ("pr_target" | "lane_base") for the same PR, when
  /// available. Used for the manual-mode footnote.
  let creationStrategy: String?

  init(
    laneId: String,
    laneName: String?,
    prNumber: Int?,
    prId: String?,
    behindCount: Int,
    conflictPredicted: Bool,
    branchRef: String?,
    baseBranch: String?,
    targetCommits: [RebaseTargetCommit]? = nil,
    rebaseMode: String? = nil,
    creationStrategy: String? = nil
  ) {
    self.laneId = laneId
    self.laneName = laneName
    self.prNumber = prNumber
    self.prId = prId
    self.behindCount = behindCount
    self.conflictPredicted = conflictPredicted
    self.branchRef = branchRef
    self.baseBranch = baseBranch
    self.targetCommits = targetCommits
    self.rebaseMode = rebaseMode
    self.creationStrategy = creationStrategy
  }

  /// Manual rebase mode is triggered by the `lane_base` PR strategy — drift
  /// against the PR target surfaces as attention only; the user must rebase
  /// by hand. `nil` and "auto" both mean the standard auto-rebase path.
  private var isManualRebaseMode: Bool {
    rebaseMode == "manual"
  }

  @State private var isDispatching = false
  @State private var errorMessage: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        hero
          .padding(.horizontal, 16)
          .padding(.top, 4)

        driftCard
          .padding(.horizontal, 16)

        PrSectionHdr(title: "Target changes") {
          Text("\(behindCount) new on \(baseBranch ?? "target")")
        }

        targetChangesCard
          .padding(.horizontal, 16)

        PrSectionHdr(title: "Conflict check")

        conflictCard
          .padding(.horizontal, 16)

        if let errorMessage, !syncService.connectionState.isHostUnreachable {
          ADENoticeCard(
            title: "Rebase failed",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: nil,
            action: nil
          )
          .padding(.horizontal, 16)
        }

        Color.clear.frame(height: 90) // space for sticky action bar
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .safeAreaInset(edge: .bottom) {
      PrStickyActionBar {
        if isManualRebaseMode {
          // Manual mode — lane_base strategy. Plain rebase is the primary
          // action; auto-resolve remains available but secondary.
          Button {
            dispatchRebase(aiAssisted: false)
          } label: {
            HStack(spacing: 6) {
              Image(systemName: "arrow.triangle.2.circlepath")
              Text("Plain rebase")
            }
            .frame(maxWidth: .infinity)
          }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.tintPRs)
          .disabled(isDispatching)

          Button {
            dispatchRebase(aiAssisted: true)
          } label: {
            HStack(spacing: 6) {
              Image(systemName: "sparkles")
              Text("Rebase + auto-resolve")
            }
            .frame(maxWidth: .infinity)
          }
          .buttonStyle(.glass)
          .disabled(isDispatching)
        } else {
          Button("Plain rebase") {
            dispatchRebase(aiAssisted: false)
          }
          .buttonStyle(.glass)
          .frame(maxWidth: .infinity)
          .disabled(isDispatching)

          Button {
            dispatchRebase(aiAssisted: true)
          } label: {
            HStack(spacing: 6) {
              Image(systemName: "sparkles")
              Text("Rebase + auto-resolve")
            }
            .frame(maxWidth: .infinity)
          }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.tintPRs)
          .disabled(isDispatching)
        }
      }
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(prNumber.map { "#\($0) · Rebase" } ?? "Rebase")
    .navigationBarTitleDisplayMode(.inline)
  }

  // MARK: - Sections

  private var hero: some View {
    let modeTint: Color = isManualRebaseMode ? ADEColor.tintPRs : ADEColor.warning
    let modeLabel = isManualRebaseMode ? "manual rebase" : "rebase needed"
    return VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        if let prNumber {
          Text("#\(prNumber)")
            .font(.system(size: 13, weight: .bold, design: .monospaced))
            .foregroundStyle(modeTint)
        }
        PrTagChip(label: modeLabel, color: modeTint)
        PrTagChip(label: "lane", color: ADEColor.accent)
        Spacer(minLength: 0)
      }
      Text(laneName ?? "Rebase lane")
        .font(.system(size: 22, weight: .bold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(3)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var driftCard: some View {
    let driftTint: Color = isManualRebaseMode ? ADEColor.tintPRs : ADEColor.warning
    let driftHeadline: String = isManualRebaseMode
      ? "PR carries an immutable base — drift detected"
      : "Auto-rebase pending — target has moved"
    let driftFootnote: String? = isManualRebaseMode
      ? "This PR was opened with lane_base strategy — auto-rebase is off."
      : nil
    return VStack(alignment: .leading, spacing: 14) {
      VStack(alignment: .leading, spacing: 4) {
        Text("\(behindCount) commit\(behindCount == 1 ? "" : "s") behind target")
          .font(.system(size: 11, weight: .bold, design: .monospaced))
          .tracking(1.2)
          .foregroundStyle(driftTint)
        Text(driftHeadline)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        if let driftFootnote {
          Text(driftFootnote)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }

      // Target track
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 8) {
          Text("TARGET")
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .tracking(1.1)
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 60, alignment: .leading)
          PrMonoText(text: baseBranch ?? "origin/main", color: ADEColor.textPrimary)
            .lineLimit(1)
        }
        PrRebaseCommitTrack(
          count: max(behindCount + 1, 2),
          lineColor: ADEColor.textSecondary.opacity(0.35),
          dotColor: ADEColor.success,
          highlightHead: true,
          highlightHere: true
        )
        .padding(.leading, 60)
      }

      // Branch track
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 8) {
          Text("BRANCH")
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .tracking(1.1)
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 60, alignment: .leading)
          PrMonoText(text: branchRef ?? (laneName ?? "lane"), color: ADEColor.textPrimary)
            .lineLimit(1)
        }
        PrRebaseCommitTrack(
          count: 3,
          lineColor: ADEColor.accent.opacity(0.45),
          dotColor: ADEColor.accent,
          highlightHead: true,
          highlightHere: true
        )
        .padding(.leading, 60)
      }
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(driftTint.opacity(0.10))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .strokeBorder(driftTint.opacity(0.30), lineWidth: 0.5)
    )
  }

  /// Renders real commits when the host provides `targetCommits`; otherwise
  /// falls back to a synthetic preview driven by `behindCount` so the layout
  /// still reflects drift on older hosts or pre-hydration.
  private var targetChangesCard: some View {
    VStack(spacing: 0) {
      if behindCount == 0 {
        HStack(spacing: 10) {
          Image(systemName: "checkmark.circle.fill")
            .foregroundStyle(ADEColor.success)
          Text("Branch is up to date with target.")
            .font(.footnote)
            .foregroundStyle(ADEColor.textPrimary)
          Spacer(minLength: 0)
        }
        .padding(14)
      } else if let commits = targetCommits, !commits.isEmpty {
        ForEach(Array(commits.enumerated()), id: \.element.id) { index, commit in
          PrTargetCommitRow(
            sha: commit.shortSha.isEmpty ? String(commit.sha.prefix(7)) : commit.shortSha,
            message: commit.subject.isEmpty ? commit.sha : commit.subject,
            author: commit.author.isEmpty ? "—" : commit.author,
            relativeAgo: prCompactRelativeTime(commit.committedAt),
            touchesYourFiles: conflictPredicted && index == 0
          )
          if index < commits.count - 1 {
            Divider().overlay(ADEColor.textMuted.opacity(0.15))
          }
        }
      } else {
        ForEach(0..<behindCount, id: \.self) { index in
          PrTargetCommitRow(
            sha: String(String(format: "%08x", abs((laneId.hashValue ^ (index * 31)))).prefix(7)).lowercased(),
            message: synthMessage(for: index),
            author: "main",
            relativeAgo: "\(index + 1)h",
            touchesYourFiles: conflictPredicted && index == 0
          )
          if index < behindCount - 1 {
            Divider().overlay(ADEColor.textMuted.opacity(0.15))
          }
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }

  private var conflictCard: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        ZStack {
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(conflictPredicted ? ADEColor.warning.opacity(0.2) : ADEColor.success.opacity(0.2))
          Image(systemName: conflictPredicted ? "exclamationmark.triangle.fill" : "checkmark.seal.fill")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(conflictPredicted ? ADEColor.warning : ADEColor.success)
        }
        .frame(width: 26, height: 26)

        VStack(alignment: .leading, spacing: 2) {
          Text(conflictPredicted ? "Likely conflict" : "No conflicts predicted")
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(ADEColor.textPrimary)
          PrMonoText(
            text: conflictPredicted ? "AI auto-resolve available" : "Rebase should apply cleanly",
            color: ADEColor.textSecondary,
            size: 10.5
          )
        }

        Spacer(minLength: 0)

        if conflictPredicted {
          PrTagChip(label: "AI can auto-resolve", color: ADEColor.tintPRs)
        }
      }

      if conflictPredicted {
        PrDiffPreview(lines: sampleConflictLines)
      }
    }
    .padding(14)
    .adeGlassCard(cornerRadius: 18)
  }

  private var sampleConflictLines: [PrDiffLine] {
    [
      PrDiffLine(lineNumber: "24", text: "<<<<<<< HEAD (\(branchRef ?? "branch"))", kind: .conflictMarker),
      PrDiffLine(lineNumber: "25", text: "const order = [auth, session, cors];", kind: .removed),
      PrDiffLine(lineNumber: "26", text: "=======", kind: .conflictMarker),
      PrDiffLine(lineNumber: "27", text: "const order = middlewares.map(m => m.priority);", kind: .added),
      PrDiffLine(lineNumber: "28", text: ">>>>>>> \(baseBranch ?? "origin/main")", kind: .conflictMarker),
    ]
  }

  private func synthMessage(for index: Int) -> String {
    switch index {
    case 0: return conflictPredicted ? "refactor: extract middleware registry" : "chore: bump deps"
    case 1: return "fix: session token expiration"
    case 2: return "chore: bump auth deps"
    default: return "update: target branch commit \(index + 1)"
    }
  }

  // MARK: - Actions

  private func dispatchRebase(aiAssisted: Bool) {
    guard !isDispatching else { return }
    isDispatching = true
    errorMessage = nil
    Task { @MainActor in
      defer { isDispatching = false }
      do {
        try await syncService.startLaneRebase(
          laneId: laneId,
          scope: "lane_only",
          pushMode: "none",
          aiAssisted: aiAssisted
        )
        dismiss()
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }
}

// MARK: - Commit track

private struct PrRebaseCommitTrack: View {
  let count: Int
  let lineColor: Color
  let dotColor: Color
  let highlightHead: Bool
  let highlightHere: Bool

  var body: some View {
    GeometryReader { geometry in
      let clamped = max(count, 1)
      let spacing = clamped > 1 ? (geometry.size.width - 13) / CGFloat(clamped - 1) : 0
      ZStack(alignment: .topLeading) {
        // Track line
        Rectangle()
          .fill(lineColor)
          .frame(height: 1.5)
          .offset(y: 6)
        // Dots
        HStack(spacing: 0) {
          ForEach(0..<clamped, id: \.self) { index in
            commitDot(index: index, total: clamped)
            if index < clamped - 1 {
              Spacer().frame(width: spacing - 13)
            }
          }
        }
      }
    }
    .frame(height: 36)
  }

  @ViewBuilder
  private func commitDot(index: Int, total: Int) -> some View {
    let isHead = highlightHead && index == total - 1
    let isHere = highlightHere && index == 0
    VStack(spacing: 2) {
      Circle()
        .fill(isHead ? dotColor : dotColor.opacity(0.7))
        .frame(width: 13, height: 13)
        .overlay(
          Circle()
            .strokeBorder(isHere ? ADEColor.tintPRs : Color.white.opacity(0.15), lineWidth: isHere ? 2 : 0.5)
        )
        .shadow(color: isHead ? dotColor.opacity(0.6) : .clear, radius: 5)
      Text(shortSha(index: index))
        .font(.system(size: 9.5, design: .monospaced))
        .foregroundStyle(ADEColor.textSecondary)
    }
  }

  private func shortSha(index: Int) -> String {
    // Deterministic short SHA so the preview and live render look stable.
    let bases = ["e42a", "d19b", "c881", "b407", "f921", "a301", "9f0c", "71ab"]
    return bases[index % bases.count]
  }
}

// MARK: - Target commit row

private struct PrTargetCommitRow: View {
  let sha: String
  let message: String
  let author: String
  let relativeAgo: String
  let touchesYourFiles: Bool

  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      Circle()
        .fill(touchesYourFiles ? ADEColor.warning : ADEColor.textSecondary.opacity(0.4))
        .frame(width: 7, height: 7)
        .shadow(color: touchesYourFiles ? ADEColor.warning.opacity(0.7) : .clear, radius: 4)

      Text(String(sha))
        .font(.system(size: 11, weight: .medium, design: .monospaced))
        .foregroundStyle(ADEColor.tintPRs)

      VStack(alignment: .leading, spacing: 2) {
        Text(message)
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        HStack(spacing: 4) {
          PrMonoText(text: author, color: ADEColor.textSecondary, size: 10.5)
          if touchesYourFiles {
            PrMonoText(text: "· touches your files", color: ADEColor.warning, size: 10.5)
          }
        }
      }

      Spacer(minLength: 0)

      Text(relativeAgo)
        .font(.system(size: 10.5, design: .monospaced))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 11)
  }
}

#Preview("PrRebaseScreen · conflict") {
  NavigationStack {
    PrRebaseScreen(
      laneId: "lane-1",
      laneName: "Fix auth middleware ordering",
      prNumber: 316,
      prId: "pr-316",
      behindCount: 3,
      conflictPredicted: true,
      branchRef: "lane/auth-fix",
      baseBranch: "origin/main"
    )
  }
}

#Preview("PrRebaseScreen · clean") {
  NavigationStack {
    PrRebaseScreen(
      laneId: "lane-2",
      laneName: "Payments idempotency key",
      prNumber: 315,
      prId: "pr-315",
      behindCount: 1,
      conflictPredicted: false,
      branchRef: "lane/payments",
      baseBranch: "origin/main"
    )
  }
}
