import SwiftUI

/// Rebase attention screen — mirrors the desktop RebaseTab detail pane:
/// drift analysis stat grid, collapsible commits list, and the full set of
/// rebase actions (AI resolver, local-only, push, defer, dismiss) so the
/// mobile and desktop paths stay in sync.
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
  let targetCommits: [RebaseTargetCommit]?
  let rebaseMode: String?
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

  private var isManualRebaseMode: Bool { rebaseMode == "manual" }
  private var effectiveBaseBranch: String { baseBranch ?? "origin/main" }

  @State private var isDispatching = false
  @State private var pendingAction: PendingAction?
  @State private var errorMessage: String?
  @State private var commitsExpanded = true

  private enum PendingAction: Equatable {
    case rebaseAi
    case rebaseLocal
    case rebasePush
    case defer4h
    case dismissLane
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        header

        if isManualRebaseMode {
          ADESettingsNotice(message: "Opened with the lane_base strategy: auto-rebase is off.", tone: .accent)
        }

        driftAnalysisCard

        if behindCount > 0 {
          newCommitsCard
        }

        rebaseActionsCard

        if let errorMessage {
          ADESettingsNotice(message: "Rebase failed: \(errorMessage)", tone: .crit)
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 24)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .adeScreenBackground()
    .navigationTitle(prNumber.map { "#\($0) · Rebase" } ?? "Rebase")
    .navigationBarTitleDisplayMode(.inline)
  }

  // MARK: - Header

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(laneName ?? "Rebase lane")
        .font(.system(size: 22, weight: .bold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
      HStack(spacing: 8) {
        Text("base:")
          .font(.adeMono(11))
          .foregroundStyle(ADEColor.textMuted)
        Text(effectiveBaseBranch)
          .font(.adeMono(11, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
        if prNumber != nil {
          ADEKitTag(text: "PR linked")
        }
        if isManualRebaseMode {
          ADEKitTag(text: "manual")
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: - Drift analysis

  private var driftAnalysisCard: some View {
    ADEKitCard(title: "Drift", symbol: "chart.bar.xaxis") {
      let behindTone: ADEKitTone = behindCount > 5 ? .warn : behindCount > 0 ? .neutral : .ok
      Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 12) {
        GridRow {
          driftStat(label: "Behind by", valueText: "\(behindCount)", suffix: behindCount == 1 ? "commit" : "commits", tone: behindTone)
          driftStat(label: "Conflicts", valueText: conflictPredicted ? "Predicted" : "None", suffix: nil, tone: conflictPredicted ? .crit : .ok)
        }
        GridRow {
          driftStat(label: "Risk", valueText: riskLabel, suffix: nil, tone: riskTone)
          driftStat(label: "Rebase mode", valueText: isManualRebaseMode ? "Manual" : "Auto", suffix: nil, tone: .neutral)
        }
      }
    }
  }

  private var riskLabel: String {
    if conflictPredicted { return "High" }
    if behindCount > 5 { return "Medium" }
    if behindCount == 0 { return "None" }
    return "Low"
  }

  private var riskTone: ADEKitTone {
    if conflictPredicted { return .crit }
    if behindCount > 5 { return .warn }
    if behindCount == 0 { return .ok }
    return .neutral
  }

  private func driftStat(label: String, valueText: String, suffix: String?, tone: ADEKitTone) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      ADEEyebrow(label)
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(valueText)
          .font(.adeMono(17, weight: .medium))
          .foregroundStyle(tone == .neutral ? ADEColor.textPrimary : tone.color)
        if let suffix {
          Text(suffix)
            .font(.system(size: 11))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: - New commits (collapsible)

  private var newCommitsCard: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) {
          commitsExpanded.toggle()
        }
      } label: {
        ADEKitCardHead(title: "New on \(effectiveBaseBranch)", symbol: "arrow.triangle.branch", count: "\(behindCount)") {
          Image(systemName: commitsExpanded ? "chevron.down" : "chevron.right")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)

      if commitsExpanded {
        Rectangle().fill(ADEKit.rule).frame(height: 0.75)
        if let commits = targetCommits, !commits.isEmpty {
          ForEach(Array(commits.enumerated()), id: \.element.id) { index, commit in
            commitRow(commit: commit)
            if index < commits.count - 1 {
              Rectangle().fill(ADEKit.rule).frame(height: 0.75).padding(.leading, ADEKit.inset)
            }
          }
        } else {
          Text("Commit details unavailable on this machine.")
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textMuted)
            .padding(ADEKit.inset)
        }
      }
    }
    .adeKitCard(padding: nil)
  }

  private func commitRow(commit: RebaseTargetCommit) -> some View {
    let sha = commit.shortSha.isEmpty ? String(commit.sha.prefix(7)) : commit.shortSha
    return HStack(alignment: .top, spacing: 10) {
      Text(sha)
        .font(.adeMono(10.5, weight: .medium))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 56, alignment: .leading)

      VStack(alignment: .leading, spacing: 2) {
        Text(commit.subject.isEmpty ? commit.sha : commit.subject)
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
        Text(commit.author.isEmpty ? "—" : commit.author)
          .font(.adeMono(10.5))
          .foregroundStyle(ADEColor.textMuted)
      }

      Spacer(minLength: 6)

      Text(prCompactRelativeTime(commit.committedAt))
        .font(.adeMono(10.5))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 10)
  }

  // MARK: - Rebase actions

  private var rebaseActionsCard: some View {
    ADEKitCard(title: "Rebase", symbol: "arrow.triangle.2.circlepath", count: "current lane") {
      VStack(alignment: .leading, spacing: 10) {
        // Rebase with AI is off with nothing to rebase (desktop parity: AI
        // only runs against the lane base).
        actionButton(action: .rebaseAi, label: "Rebase with AI", icon: "sparkles", prominent: true, disabled: behindCount == 0)

        HStack(spacing: 8) {
          actionButton(action: .rebaseLocal, label: "Rebase now", icon: nil, prominent: false, disabled: behindCount == 0)
          actionButton(action: .rebasePush, label: "Rebase + push", icon: "arrow.up.circle", prominent: false, disabled: behindCount == 0)
        }

        HStack(spacing: 8) {
          actionButton(action: .defer4h, label: "Defer 4h", icon: "clock", prominent: false, disabled: false)
          actionButton(action: .dismissLane, label: "Dismiss", icon: "xmark.circle", prominent: false, disabled: false)
        }

        if behindCount == 0 {
          HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
              .foregroundStyle(ADEColor.success)
              .font(.system(size: 12))
            Text("Up to date with \(effectiveBaseBranch).")
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
      }
    }
  }

  @ViewBuilder
  private func actionButton(
    action: PendingAction,
    label: String,
    icon: String?,
    prominent: Bool,
    disabled: Bool
  ) -> some View {
    let isRunning = pendingAction == action && isDispatching
    let isDisabled = disabled || (isDispatching && pendingAction != action)

    Button {
      perform(action: action)
    } label: {
      HStack(spacing: 6) {
        if isRunning {
          ProgressView()
            .controlSize(.small)
            .tint(prominent ? .white : ADEColor.textPrimary)
        } else if let icon {
          Image(systemName: icon)
            .font(.system(size: 12, weight: .semibold))
        }
        Text(label)
      }
    }
    .buttonStyle(ADEKitButtonStyle(prominent: prominent, wide: true))
    .disabled(isDisabled || isRunning)
    .opacity(isDisabled ? 0.45 : 1)
  }

  // MARK: - Dispatch

  private func perform(action: PendingAction) {
    guard !isDispatching else { return }
    isDispatching = true
    pendingAction = action
    errorMessage = nil
    Task { @MainActor in
      defer {
        isDispatching = false
        pendingAction = nil
      }
      do {
        switch action {
        case .rebaseAi:
          try await syncService.startLaneRebase(
            laneId: laneId, scope: "lane_only", pushMode: "none", aiAssisted: true
          )
          dismiss()
        case .rebaseLocal:
          try await syncService.startLaneRebase(
            laneId: laneId, scope: "lane_only", pushMode: "none", aiAssisted: false
          )
          dismiss()
        case .rebasePush:
          try await syncService.startLaneRebase(
            laneId: laneId, scope: "lane_only", pushMode: "review_then_push", aiAssisted: false
          )
          dismiss()
        case .defer4h:
          try await syncService.deferRebaseSuggestion(laneId: laneId, minutes: 240)
          dismiss()
        case .dismissLane:
          try await syncService.dismissRebaseSuggestion(laneId: laneId)
          dismiss()
        }
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }
}

#Preview("PrRebaseScreen · conflict") {
  NavigationStack {
    PrRebaseScreen(
      laneId: "lane-1",
      laneName: "Fix auth middleware ordering",
      prNumber: 316,
      prId: "pr-316",
      behindCount: 83,
      conflictPredicted: true,
      branchRef: "lane/auth-fix",
      baseBranch: "origin/main",
      targetCommits: [
        RebaseTargetCommit(sha: "70fd4e51aaaa", shortSha: "70fd4e5", subject: "Review engine: multi-pass pipeline", author: "Arul", committedAt: ""),
        RebaseTargetCommit(sha: "56ec29c5bbbb", shortSha: "56ec29c", subject: "chat-ux: collapse thoughts + scroll", author: "Arul", committedAt: ""),
      ]
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
      behindCount: 0,
      conflictPredicted: false,
      branchRef: "lane/payments",
      baseBranch: "origin/main"
    )
  }
}
