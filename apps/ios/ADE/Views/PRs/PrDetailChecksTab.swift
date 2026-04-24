import SwiftUI

struct PrChecksTab: View {
  let checks: [PrCheck]
  let actionRuns: [PrActionRun]
  let deployments: [PrDeployment]
  let canRerunChecks: Bool
  let isLive: Bool
  let aiResolution: AiResolutionState?
  let isAiResolverBusy: Bool
  let onRerun: () -> Void
  let onLaunchAiResolver: () -> Void
  let onStopAiResolver: () -> Void

  init(
    checks: [PrCheck],
    actionRuns: [PrActionRun],
    deployments: [PrDeployment] = [],
    canRerunChecks: Bool,
    isLive: Bool,
    aiResolution: AiResolutionState? = nil,
    isAiResolverBusy: Bool = false,
    onRerun: @escaping () -> Void,
    onLaunchAiResolver: @escaping () -> Void = {},
    onStopAiResolver: @escaping () -> Void = {}
  ) {
    self.checks = checks
    self.actionRuns = actionRuns
    self.deployments = deployments
    self.canRerunChecks = canRerunChecks
    self.isLive = isLive
    self.aiResolution = aiResolution
    self.isAiResolverBusy = isAiResolverBusy
    self.onRerun = onRerun
    self.onLaunchAiResolver = onLaunchAiResolver
    self.onStopAiResolver = onStopAiResolver
  }

  private var stats: PrChecksStatStrip.Stats {
    var fail = 0, pending = 0, pass = 0
    for check in checks {
      switch prCheckConclusionKind(check) {
      case .success: pass += 1
      case .failure: fail += 1
      case .pending: pending += 1
      case .neutral: break
      }
    }
    return .init(fail: fail, pending: pending, pass: pass, total: checks.count)
  }

  private var groups: [PrCheckGroup] {
    PrCheckGroup.buildGroups(from: checks)
  }

  private var hasFailedChecks: Bool {
    checks.contains { prCheckConclusionKind($0) == .failure }
  }

  private var aiResolverRunning: Bool {
    let status = aiResolution?.status?.lowercased() ?? ""
    return status == "running" || status == "starting" || status == "pending"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      PrChecksStatStrip(stats: stats)

      if checks.isEmpty {
        ADEEmptyStateView(
          symbol: "checklist",
          title: "No CI checks",
          message: "No check runs were synced for this PR yet."
        )
      } else {
        ForEach(groups, id: \.kind) { group in
          PrChecksGroupCard(group: group)
        }
      }

      if !deployments.isEmpty {
        PrDetailSectionCard("Deployments") {
          VStack(spacing: 0) {
            ForEach(Array(deployments.enumerated()), id: \.1.id) { index, deployment in
              if index > 0 {
                Divider().overlay(ADEColor.glassBorder)
              }
              PrDeploymentRow(deployment: deployment)
            }
          }
          .adeInsetField(cornerRadius: 12, padding: 0)
        }
      }

      if !actionRuns.isEmpty {
        PrDetailSectionCard("Action runs") {
          VStack(alignment: .leading, spacing: 12) {
            ForEach(actionRuns) { run in
              PrActionRunRow(run: run)
            }
          }
        }
      }

      PrChecksActionsRow(
        canRerun: canRerunChecks && isLive && hasFailedChecks,
        isAiBusy: isAiResolverBusy,
        isAiRunning: aiResolverRunning,
        isLive: isLive,
        onRerun: onRerun,
        onLaunchAi: onLaunchAiResolver,
        onStopAi: onStopAiResolver
      )

      if !canRerunChecks {
        Text("This host has not exposed PR check reruns to the mobile sync channel yet.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
  }
}

// MARK: - Stat strip

private struct PrChecksStatStrip: View {
  struct Stats {
    let fail: Int
    let pending: Int
    let pass: Int
    let total: Int
  }

  let stats: Stats

  var body: some View {
    HStack(spacing: 6) {
      PrCheckStatPill(count: stats.fail, label: "Fail", color: ADEColor.danger)
      PrCheckStatPill(count: stats.pending, label: "Pending", color: ADEColor.warning)
      PrCheckStatPill(count: stats.pass, label: "Pass", color: ADEColor.success)
      PrCheckStatPill(count: stats.total, label: "Total", color: ADEColor.tintPRs)
    }
  }
}

// MARK: - Groups

private enum PrCheckGroupKind: String, CaseIterable {
  case ci, bots, security, other

  var label: String {
    switch self {
    case .ci: return "CI"
    case .bots: return "Bots"
    case .security: return "Security"
    case .other: return "Other"
    }
  }
}

private struct PrCheckGroup {
  let kind: PrCheckGroupKind
  let checks: [PrCheck]

  static func buildGroups(from checks: [PrCheck]) -> [PrCheckGroup] {
    var buckets: [PrCheckGroupKind: [PrCheck]] = [:]
    for check in checks {
      let kind = classify(check)
      buckets[kind, default: []].append(check)
    }
    return PrCheckGroupKind.allCases.compactMap { kind in
      guard let entries = buckets[kind], !entries.isEmpty else { return nil }
      return PrCheckGroup(kind: kind, checks: entries)
    }
  }

  static func classify(_ check: PrCheck) -> PrCheckGroupKind {
    let name = check.name.lowercased()
    let host = detailsHost(for: check).lowercased()
    let haystack = "\(name) \(host)"
    let securityKeywords = ["codeql", "snyk", "dependabot", "trivy", "semgrep"]
    if securityKeywords.contains(where: { haystack.contains($0) }) {
      return .security
    }
    let botKeywords = ["coderabbit", "greptile", "sonarcloud", "codecov", "sourcery", "seer", "reviewbot", "codeql-bot"]
    if botKeywords.contains(where: { haystack.contains($0) }) {
      return .bots
    }
    return .ci
  }
}

private struct PrChecksGroupCard: View {
  let group: PrCheckGroup

  private var summary: AttributedString {
    var pass = 0
    var fail = 0
    var pending = 0
    for check in group.checks {
      switch prCheckConclusionKind(check) {
      case .success: pass += 1
      case .failure: fail += 1
      case .pending: pending += 1
      case .neutral: break
      }
    }
    var parts: [AttributedString] = []
    if fail > 0 {
      var f = AttributedString("\(fail) fail")
      f.foregroundColor = ADEColor.danger
      parts.append(f)
    }
    if pending > 0 {
      var p = AttributedString("\(pending) pending")
      p.foregroundColor = ADEColor.warning
      parts.append(p)
    }
    if pass > 0 {
      var s = AttributedString("\(pass) pass")
      s.foregroundColor = ADEColor.success
      parts.append(s)
    }
    if parts.isEmpty {
      var s = AttributedString("\(group.checks.count) total")
      s.foregroundColor = ADEColor.textSecondary
      return s
    }
    var result = AttributedString("")
    for (index, part) in parts.enumerated() {
      if index > 0 {
        var sep = AttributedString(" · ")
        sep.foregroundColor = ADEColor.textMuted
        result.append(sep)
      }
      result.append(part)
    }
    return result
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(group.kind.label.uppercased())
          .font(.system(size: 11, weight: .semibold, design: .monospaced))
          .tracking(1.2)
          .foregroundColor(ADEColor.textSecondary)
        Spacer(minLength: 12)
        Text(summary)
          .font(.system(size: 11, weight: .semibold, design: .monospaced))
      }
      .padding(.horizontal, 4)
      .padding(.top, 4)
      .padding(.bottom, 4)

      VStack(spacing: 0) {
        ForEach(Array(group.checks.enumerated()), id: \.1.id) { index, check in
          if index > 0 {
            Divider().overlay(ADEColor.glassBorder)
          }
          PrCheckRowCompact(
            check: check,
            isBot: group.kind == .bots,
            isSecurity: group.kind == .security
          )
        }
      }
      .background(ADEColor.glassBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .strokeBorder(ADEColor.glassBorder, lineWidth: 0.5)
      )
    }
  }
}

private struct PrCheckRowCompact: View {
  let check: PrCheck
  let isBot: Bool
  let isSecurity: Bool

  @State private var expanded = false

  private var kind: PrCheckConclusionKind { prCheckConclusionKind(check) }

  private var tint: Color {
    switch kind {
    case .success: return ADEColor.success
    case .failure: return ADEColor.danger
    case .pending: return ADEColor.warning
    case .neutral: return ADEColor.textSecondary
    }
  }

  private var iconName: String {
    switch kind {
    case .success: return "checkmark"
    case .failure: return "xmark"
    case .pending: return "circle"
    case .neutral: return "minus"
    }
  }

  private var subLine: String {
    if let details = check.detailsUrl, !details.isEmpty, let url = URL(string: details), let host = url.host {
      if let context = check.conclusion ?? Optional(check.status), !context.isEmpty {
        return "\(host) · \(context)"
      }
      return host
    }
    if let conclusion = check.conclusion { return conclusion }
    return check.status.replacingOccurrences(of: "_", with: " ")
  }

  private var duration: String? {
    if kind == .pending { return "running…" }
    return prDurationText(startedAt: check.startedAt, completedAt: check.completedAt)
  }

  private var hasDetails: Bool {
    guard let details = check.detailsUrl, !details.isEmpty else { return false }
    return URL(string: details) != nil
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        if hasDetails {
          withAnimation(.easeInOut(duration: 0.18)) { expanded.toggle() }
        }
      } label: {
        HStack(alignment: .top, spacing: 10) {
          ZStack {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
              .fill(tint.opacity(0.15))
            Image(systemName: iconName)
              .font(.system(size: 11, weight: .heavy))
              .foregroundStyle(tint)
          }
          .frame(width: 22, height: 22)
          .padding(.top, 1)

          VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
              Text(check.name)
                .font(.system(.footnote, design: .monospaced).weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(1)
              if isBot {
                PrTagChip(label: "bot", color: ADEColor.tintPRs)
              }
              if isSecurity {
                PrTagChip(label: "security", color: ADEColor.accent)
              }
              Spacer(minLength: 0)
            }
            Text(subLine)
              .font(.system(size: 10, design: .monospaced))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
            if kind == .failure, let context = check.conclusion, !context.isEmpty, context != "failure" {
              Text(context)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(ADEColor.danger)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(ADEColor.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(
                  RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(ADEColor.danger.opacity(0.22), lineWidth: 0.5)
                )
                .padding(.top, 3)
            }
          }

          if let duration {
            Text(duration)
              .font(.system(size: 10, design: .monospaced))
              .foregroundStyle(ADEColor.textMuted)
              .padding(.top, 3)
          }

          if hasDetails {
            Image(systemName: "chevron.right")
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
              .rotationEffect(.degrees(expanded ? 90 : 0))
              .animation(.easeInOut(duration: 0.18), value: expanded)
              .padding(.top, 3)
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)

      if expanded, let details = check.detailsUrl, let url = URL(string: details) {
        Divider().overlay(ADEColor.glassBorder).padding(.leading, 44)
        HStack(spacing: 8) {
          Image(systemName: "arrow.up.right.square")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
          Link("Open check details", destination: url)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
          Spacer(minLength: 0)
          if let started = check.startedAt, let completed = check.completedAt {
            let dur = prDurationText(startedAt: started, completedAt: completed)
            if let dur {
              Text(dur)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(ADEColor.textMuted)
            }
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .padding(.leading, 32)
      }
    }
  }
}

// MARK: - Deployments

private struct PrDeploymentRow: View {
  let deployment: PrDeployment

  private var stateTint: Color {
    switch deployment.state.lowercased() {
    case "success", "active": return ADEColor.success
    case "failure", "error": return ADEColor.danger
    case "pending", "queued", "in_progress": return ADEColor.warning
    default: return ADEColor.textSecondary
    }
  }

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "shippingbox.fill")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(stateTint)
        .frame(width: 22, height: 22)
        .background(stateTint.opacity(0.15), in: RoundedRectangle(cornerRadius: 6, style: .continuous))

      VStack(alignment: .leading, spacing: 2) {
        Text(deployment.environment)
          .font(.footnote.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(deployment.sha.prefix(7) + (deployment.description.map { " · \($0)" } ?? ""))
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }

      Spacer(minLength: 8)

      ADEStatusPill(text: deployment.state.uppercased(), tint: stateTint)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }
}

// MARK: - Bottom actions

private struct PrChecksActionsRow: View {
  let canRerun: Bool
  let isAiBusy: Bool
  let isAiRunning: Bool
  let isLive: Bool
  let onRerun: () -> Void
  let onLaunchAi: () -> Void
  let onStopAi: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      Button {
        ADEHaptics.success()
        onRerun()
      } label: {
        HStack(spacing: 6) {
          Image(systemName: "arrow.triangle.2.circlepath")
            .font(.system(size: 11, weight: .semibold))
          Text("Retry failed")
            .font(.caption.weight(.semibold))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 11)
        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(ADEColor.glassBorder, lineWidth: 0.5)
        )
        .foregroundStyle(ADEColor.textSecondary)
      }
      .buttonStyle(.plain)
      .disabled(!canRerun)
      .opacity(canRerun ? 1 : 0.5)

      Button {
        if isAiRunning { onStopAi() } else { onLaunchAi() }
      } label: {
        HStack(spacing: 6) {
          if isAiBusy {
            ProgressView().controlSize(.mini).tint(.black)
          } else {
            Image(systemName: isAiRunning ? "stop.fill" : "sparkles")
              .font(.system(size: 11, weight: .bold))
          }
          Text(isAiRunning ? "Stop AI" : "Fix with AI")
            .font(.caption.weight(.bold))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 11)
        .background(isAiRunning ? ADEColor.danger : ADEColor.tintPRs, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .foregroundStyle(isAiRunning ? Color.white : Color.black)
      }
      .buttonStyle(.plain)
      .disabled(isAiBusy || !isLive)
      .opacity((isAiBusy || !isLive) ? 0.6 : 1)
    }
  }
}

// MARK: - Classification helper

private enum PrCheckConclusionKind {
  case success, failure, pending, neutral
}

private func prCheckConclusionKind(_ check: PrCheck) -> PrCheckConclusionKind {
  if check.status != "completed" {
    return .pending
  }
  switch check.conclusion {
  case "success": return .success
  case "failure", "timed_out", "cancelled", "action_required", "startup_failure":
    return .failure
  case "neutral", "skipped", "stale":
    return .neutral
  default:
    return .neutral
  }
}

// MARK: - Action run (kept from prior impl)

struct PrActionRunRow: View {
  let run: PrActionRun
  @State private var expanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Button {
        withAnimation(.snappy) {
          expanded.toggle()
        }
      } label: {
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: run.conclusion == "success" ? "checkmark.circle.fill" : run.status == "completed" ? "xmark.circle.fill" : "circle.dashed")
            .foregroundStyle(run.conclusion == "success" ? ADEColor.success : run.status == "completed" ? ADEColor.danger : ADEColor.warning)
          VStack(alignment: .leading, spacing: 4) {
            Text(run.name)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text((run.conclusion ?? run.status).replacingOccurrences(of: "_", with: " ").uppercased())
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
          Spacer(minLength: 0)
          Image(systemName: expanded ? "chevron.up" : "chevron.down")
            .font(.caption.weight(.bold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .buttonStyle(.plain)

      if expanded {
        ForEach(run.jobs) { job in
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text(job.name)
                .font(.caption.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              Spacer(minLength: 0)
              Text((job.conclusion ?? job.status).uppercased())
                .font(.caption2.weight(.bold))
                .foregroundStyle(job.conclusion == "success" ? ADEColor.success : ADEColor.textSecondary)
            }
            ForEach(job.steps.prefix(6)) { step in
              HStack(spacing: 8) {
                Text("\(step.number)")
                  .font(.caption2.monospacedDigit())
                  .foregroundStyle(ADEColor.textMuted)
                Text(step.name)
                  .font(.caption2)
                  .foregroundStyle(ADEColor.textSecondary)
                Spacer(minLength: 0)
                Text((step.conclusion ?? step.status).uppercased())
                  .font(.caption2)
                  .foregroundStyle(ADEColor.textMuted)
              }
            }
          }
          .adeInsetField(cornerRadius: 12, padding: 10)
        }

        if let url = URL(string: run.htmlUrl), !run.htmlUrl.isEmpty {
          Link(destination: url) {
            Label("Open run", systemImage: "arrow.up.right.square")
              .font(.caption.weight(.semibold))
          }
          .foregroundStyle(ADEColor.accent)
        }
      }
    }
    .adeInsetField(cornerRadius: 14, padding: 12)
  }
}

// MARK: - details host helper

private func detailsHost(for check: PrCheck) -> String {
  guard let details = check.detailsUrl, let url = URL(string: details), let host = url.host else {
    return ""
  }
  return host
}
