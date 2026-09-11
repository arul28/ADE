import SwiftUI

enum SyncHostOwnerKind: String, Equatable {
  case installed
  case development
  case unknown
}

enum SyncHostReadinessState: String, Equatable {
  case ready
  case starting
  case conflict
  case unavailable
}

struct SyncHostConflictPublic: Equatable {
  var reason: String
  var ownerKind: SyncHostOwnerKind
  var ownerLabel: String
  var projectLabel: String?
  var impact: String?
  var recoveryEligible: Bool
  var technicalDetail: String
}

struct SyncHostReadinessSnapshot: Equatable {
  var state: SyncHostReadinessState
  var headline: String
  var body: String
  var conflict: SyncHostConflictPublic?
  var recoveryEligible: Bool
}

enum ProjectHostUiPhase: String, Equatable {
  case ready
  case retrying
  case takeover
  case recovering
}

struct SyncHostRecoveryStep: Equatable {
  var id: String
  var status: String
  var detail: String?
}

struct SyncHostRecoveryResult: Equatable {
  var operationId: String
  var ok: Bool
  var status: String
  var snapshot: SyncHostReadinessSnapshot
  var steps: [SyncHostRecoveryStep]
  var message: String
}

let projectHostSilentRetrySeconds: [TimeInterval] = [2, 4, 8]

/// What the silent re-check loop does next.
enum ProjectHostSilentRetryStep: Equatable {
  case check(afterSeconds: TimeInterval)
  case exhausted
  case stop
}

/// The ramp is the budget for a machine that is merely slow to start: spend it,
/// then hand the user the takeover card. A repair in progress has no budget —
/// the phone asked for the restart, so it keeps checking at the last interval
/// until the machine is ready or the user acts.
func projectHostSilentRetryStep(
  phase: ProjectHostUiPhase,
  completedAttempts: Int
) -> ProjectHostSilentRetryStep {
  let attempts = max(0, completedAttempts)
  switch phase {
  case .recovering:
    let index = min(attempts, projectHostSilentRetrySeconds.count - 1)
    return .check(afterSeconds: projectHostSilentRetrySeconds[index])
  case .retrying:
    guard attempts < projectHostSilentRetrySeconds.count else { return .exhausted }
    return .check(afterSeconds: projectHostSilentRetrySeconds[attempts])
  case .ready, .takeover:
    return .stop
  }
}

func parseSyncHostReadinessSnapshot(_ raw: Any?) -> SyncHostReadinessSnapshot? {
  guard let record = raw as? [String: Any] else { return nil }
  let stateRaw = (record["state"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard let state = SyncHostReadinessState(rawValue: stateRaw) else { return nil }
  let headline = (record["headline"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let body = (record["body"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard !headline.isEmpty, !body.isEmpty else { return nil }
  let conflict = parseSyncHostConflict(record["conflict"])
  return SyncHostReadinessSnapshot(
    state: state,
    headline: headline,
    body: body,
    conflict: conflict,
    recoveryEligible: (record["recoveryEligible"] as? Bool) == true || conflict?.recoveryEligible == true
  )
}

func parseSyncHostConflict(_ raw: Any?) -> SyncHostConflictPublic? {
  guard let record = raw as? [String: Any] else { return nil }
  let reason = (record["reason"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let ownerKindRaw = (record["ownerKind"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let ownerLabel = (record["ownerLabel"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let technical = (record["technicalDetail"] as? String) ?? ""
  guard reason == "lock" || reason == "listener" else { return nil }
  guard let ownerKind = SyncHostOwnerKind(rawValue: ownerKindRaw), !ownerLabel.isEmpty else { return nil }
  let projectLabel = (record["projectLabel"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
  let impact = (record["impact"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
  return SyncHostConflictPublic(
    reason: reason,
    ownerKind: ownerKind,
    ownerLabel: ownerLabel,
    projectLabel: (projectLabel?.isEmpty == false) ? projectLabel : nil,
    impact: (impact?.isEmpty == false) ? impact : nil,
    recoveryEligible: (record["recoveryEligible"] as? Bool) == true,
    technicalDetail: technical
  )
}

func parseSyncHostRecoveryResult(_ raw: Any?) -> SyncHostRecoveryResult? {
  guard let record = raw as? [String: Any],
        let snapshot = parseSyncHostReadinessSnapshot(record["snapshot"]) else {
    return nil
  }
  let steps = (record["steps"] as? [[String: Any]] ?? []).compactMap { step -> SyncHostRecoveryStep? in
    let id = (step["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !id.isEmpty else { return nil }
    return SyncHostRecoveryStep(
      id: id,
      status: (step["status"] as? String) ?? "pending",
      detail: step["detail"] as? String
    )
  }
  return SyncHostRecoveryResult(
    operationId: (record["operationId"] as? String) ?? "",
    ok: (record["ok"] as? Bool) == true,
    status: (record["status"] as? String) ?? "failed",
    snapshot: snapshot,
    steps: steps,
    message: (record["message"] as? String) ?? snapshot.body
  )
}

func syncHostReadinessSnapshot(from error: Error) -> SyncHostReadinessSnapshot? {
  let userInfo = (error as NSError).userInfo
  if let snapshot = parseSyncHostReadinessSnapshot(userInfo["ADEHostSnapshot"]) {
    return snapshot
  }
  return parseSyncHostReadinessSnapshot(userInfo)
}

func projectHostShouldTakeOverImmediately(_ snapshot: SyncHostReadinessSnapshot?) -> Bool {
  guard let snapshot else { return false }
  return snapshot.state == .conflict || snapshot.conflict != nil
}

func nextProjectHostPhase(
  current: ProjectHostUiPhase,
  snapshot: SyncHostReadinessSnapshot?,
  retriesExhausted: Bool = false
) -> ProjectHostUiPhase {
  guard let snapshot, snapshot.state != .ready else { return .ready }
  if current == .recovering { return .recovering }
  if projectHostShouldTakeOverImmediately(snapshot) || retriesExhausted { return .takeover }
  if current == .takeover { return .takeover }
  return .retrying
}

/// Two forms per step: what it is doing, and what it did. A finished step that
/// still reads "Stopping…" is the reason status words leaked into this list in
/// the first place. Mirrors `STEP_LABELS` in the desktop recovery screen.
func projectHostRecoveryStepLabel(_ id: String, done: Bool = false) -> String {
  switch id {
  case "diagnose": return done ? "Checked this machine" : "Checking this machine"
  case "stop": return done ? "Stopped blocking runtime" : "Stopping the blocking runtime"
  case "wait": return done ? "Connection freed" : "Freeing the connection"
  case "start": return done ? "Started the project connection" : "Starting the project connection"
  case "restart": return done ? "Restarted this machine" : "Restarting this machine"
  case "prove": return done ? "Chats are back" : "Checking chats"
  default: return id
  }
}

/// The mark a recovery step draws. Raw host status words ("done", "pending")
/// are never shown; they map to a symbol and a spoken word instead.
enum ProjectHostRecoveryStepMark: String, Equatable {
  case done
  case active
  case pending
  case failed

  var symbol: String {
    switch self {
    case .done: return "checkmark.circle.fill"
    case .active: return "circle.fill"
    case .pending: return "circle"
    case .failed: return "exclamationmark.triangle.fill"
    }
  }

  var spokenStatus: String {
    switch self {
    case .done: return "done"
    case .active: return "in progress"
    case .pending: return "waiting"
    case .failed: return "failed"
    }
  }
}

/// `nil` means the step is not worth drawing — a skipped step is noise, not
/// progress.
func projectHostRecoveryStepMark(_ status: String) -> ProjectHostRecoveryStepMark? {
  switch status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "skipped": return nil
  case "done", "succeeded": return .done
  case "active", "running": return .active
  case "failed": return .failed
  default: return .pending
  }
}

struct ProjectHostRecoveryStepRow: Equatable, Identifiable {
  var id: String
  var label: String
  var mark: ProjectHostRecoveryStepMark
}

func projectHostRecoveryStepRows(_ steps: [SyncHostRecoveryStep]) -> [ProjectHostRecoveryStepRow] {
  steps.compactMap { step in
    guard let mark = projectHostRecoveryStepMark(step.status) else { return nil }
    return ProjectHostRecoveryStepRow(
      id: step.id,
      label: projectHostRecoveryStepLabel(step.id, done: mark == .done),
      mark: mark
    )
  }
}

/// Runtime-scoped host actions, mirroring the brain's command names. Named here
/// so the recovery surface and `SyncService` never drift on the spelling.
let projectHostDiagnoseAction = "sync.diagnoseHost"
let projectHostRecoverAction = "sync.recoverHost"

/// The exact sentence the brain sends instead of runtime ownership details when
/// the asking device has no runtime-management grant.
let projectHostRedactedConflictDetail =
  "Runtime ownership details are available only to an authorized device."

/// Why a conflict offers no one-tap repair. `nil` when repair is on offer.
/// Mirrors `projectHostBlockedReason` in `shared/syncHostRecoveryUi.ts`.
enum ProjectHostBlockedReason: String, Equatable {
  case unauthorized
  case unidentified
}

func projectHostBlockedReason(_ snapshot: SyncHostReadinessSnapshot?) -> ProjectHostBlockedReason? {
  guard let snapshot, let conflict = snapshot.conflict, !snapshot.recoveryEligible else { return nil }
  return conflict.technicalDetail.trimmingCharacters(in: .whitespacesAndNewlines)
    == projectHostRedactedConflictDetail
    ? .unauthorized
    : .unidentified
}

/// One sentence for each conflict this phone cannot fix, so the screen never
/// leaves the user staring at a card with no way forward.
func projectHostIneligibleGuidance(_ snapshot: SyncHostReadinessSnapshot?) -> String? {
  switch projectHostBlockedReason(snapshot) {
  case .unauthorized:
    return "This iPhone can't stop the other runtime — retry, switch Macs, or stop it on that Mac."
  case .unidentified:
    return "ADE can't safely stop the other runtime from here, so stop it on that Mac."
  case nil:
    return nil
  }
}

struct ProjectHostRecoveryScreen: View {
  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    let snapshot = syncService.projectHostSnapshot
    let recovering = syncService.projectHostPhase == .recovering

    ZStack {
      ADEColor.pageBackground.opacity(0.96)
        .ignoresSafeArea()
      VStack(alignment: .leading, spacing: 18) {
        header
        Spacer(minLength: 12)
        Group {
          if recovering {
            progressCard
          } else {
            conflictCard(snapshot)
          }
        }
        Spacer(minLength: 12)
      }
      .padding(20)
      .frame(maxWidth: 560)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(
      recovering ? "Fixing the connection" : (snapshot?.headline ?? "Couldn't use this machine")
    )
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        syncService.showProjectHub()
      } label: {
        Label("Machines", systemImage: "chevron.left")
          .font(.subheadline.weight(.semibold))
      }
      .buttonStyle(.plain)
      .foregroundStyle(ADEColor.accent)

      Text(syncService.machineDisplayName)
        .font(.footnote.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
  }

  @ViewBuilder
  private func conflictCard(_ snapshot: SyncHostReadinessSnapshot?) -> some View {
    let conflict = snapshot?.conflict
    let canFix = snapshot?.recoveryEligible == true && conflict != nil
    let guidance = projectHostIneligibleGuidance(snapshot)

    VStack(alignment: .leading, spacing: 10) {
      Text(snapshot?.headline ?? "Couldn't use this machine")
        .font(.title3.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text(snapshot?.body ?? "This machine's project connection isn't ready yet.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)

      if let conflict {
        VStack(alignment: .leading, spacing: 2) {
          Text(conflict.ownerLabel)
          if let projectLabel = conflict.projectLabel {
            Text(projectLabel)
          }
          // What stopping the runtime costs — the one line that lets the user
          // decide whether to tap Fix connection.
          if let impact = conflict.impact {
            Text(impact)
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      }

      if canFix {
        Button("Fix connection") {
          Task { await syncService.recoverProjectHost() }
        }
        .buttonStyle(.glassProminent)
        .padding(.top, 4)
      } else if let guidance {
        Text(guidance)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.top, 4)
      }

      // With no Fix connection button there is no primary action on the card,
      // so Retry becomes it. Otherwise Retry stays the quieter second choice.
      if canFix {
        HStack(spacing: 16) {
          Button("Retry") {
            Task { await syncService.retryProjectHost() }
          }
          Button("Switch Mac") {
            syncService.settingsPresented = true
          }
        }
        .font(.subheadline.weight(.semibold))
        .padding(.top, 2)
      } else {
        Button("Retry") {
          Task { await syncService.retryProjectHost() }
        }
        .buttonStyle(.glassProminent)
        .padding(.top, 4)

        Button("Switch Mac") {
          syncService.settingsPresented = true
        }
        .font(.subheadline.weight(.semibold))
        .padding(.top, 2)
      }

      // A redacted detail says the same thing the guidance above already does,
      // so the fold would only offer the user an empty drawer.
      if projectHostBlockedReason(snapshot) != .unauthorized,
         let technical = conflict?.technicalDetail.trimmingCharacters(in: .whitespacesAndNewlines),
         !technical.isEmpty {
        ADETechnicalDetailsFold(text: technical)
          .padding(.top, 6)
      }
    }
    .adeGlassCard()
  }

  private var progressCard: some View {
    let rows = projectHostRecoveryStepRows(syncService.projectHostRecovery?.steps ?? [])

    return VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        ProgressView()
          .controlSize(.small)
        Text("Fixing the connection…")
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
      }

      if !rows.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(rows) { row in
            ProjectHostRecoveryStepRowView(row: row)
          }
        }
      }

      Text("You can switch machines.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textMuted)

      // Retry stays live during the repair. A restart that never comes back
      // would otherwise leave this screen an inert spinner with no way out.
      HStack(spacing: 16) {
        Button("Retry") {
          Task { await syncService.retryProjectHost() }
        }
        Button("Switch Mac") {
          syncService.settingsPresented = true
        }
      }
      .font(.subheadline.weight(.semibold))
    }
    .adeGlassCard()
  }
}

private struct ProjectHostRecoveryStepRowView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let row: ProjectHostRecoveryStepRow
  @State private var pulsing = false

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: row.mark.symbol)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(tint)
        .opacity(row.mark == .active && pulsing ? 0.45 : 1)
        .frame(width: 16)
      Text(row.label)
        .font(.subheadline)
        .foregroundStyle(row.mark == .pending ? ADEColor.textMuted : ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .onAppear {
      guard row.mark == .active, let pulse = ADEMotion.pulse(reduceMotion: reduceMotion) else { return }
      withAnimation(pulse) { pulsing = true }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(row.label), \(row.mark.spokenStatus)")
  }

  private var tint: Color {
    switch row.mark {
    case .done: return ADEColor.success
    case .active: return ADEColor.accent
    case .pending: return ADEColor.textMuted
    case .failed: return ADEColor.warning
    }
  }
}
