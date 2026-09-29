import SwiftUI

// The Checks tab on the flat base: one summary line, then FAILING, RUNNING
// and PASSED (folded) sections. A row opens the check's page with its job
// steps and the link to its log on GitHub.

// MARK: - Rules

struct PrChecksSummaryStats: Equatable {
  let fail: Int
  let pending: Int
  let pass: Int
  /// Neutral / skipped: not a pass, since nothing was verified.
  let skipped: Int
  let total: Int
}

func prChecksSummaryStats(checks: [PrCheck], overallChecksStatus: String?) -> PrChecksSummaryStats {
  var fail = 0, pending = 0, pass = 0, skipped = 0
  for check in checks {
    switch prCheckConclusionKind(check) {
    case .success: pass += 1
    case .failure: fail += 1
    case .pending: pending += 1
    case .neutral: skipped += 1
    }
  }
  if !checks.isEmpty {
    // ADE-135: when the host says nothing verified the commit, third-party
    // `success` rows are reported as unverified, never as passes.
    if overallChecksStatus?.lowercased() == "not_run" {
      return .init(fail: fail, pending: pending, pass: 0, skipped: pass + skipped, total: checks.count)
    }
    return .init(fail: fail, pending: pending, pass: pass, skipped: skipped, total: checks.count)
  }
  switch overallChecksStatus?.lowercased() {
  case "failing", "failure", "failed": return .init(fail: 1, pending: 0, pass: 0, skipped: 0, total: 1)
  case "pending", "running", "in_progress": return .init(fail: 0, pending: 1, pass: 0, skipped: 0, total: 1)
  case "passing", "success", "passed": return .init(fail: 0, pending: 0, pass: 1, skipped: 0, total: 1)
  default: return .init(fail: 0, pending: 0, pass: 0, skipped: 0, total: 0)
  }
}

func prChecksEmptyStateCopy(overallChecksStatus: String?, checksReason: String? = nil) -> (title: String, message: String) {
  switch overallChecksStatus?.lowercased() {
  case "not_run":
    return ("No CI ran on this commit", checksReason ?? noCIReasonText)
  case "failing", "failure", "failed":
    return ("Checks failing", "The PR summary reports failing checks, but individual check runs have not synced yet.")
  case "pending", "running", "in_progress":
    return ("Checks pending", "The PR summary reports pending checks, but individual check runs have not synced yet.")
  case "passing", "success", "passed":
    return ("Checks passing", "The PR summary reports passing checks, but individual check runs have not synced yet.")
  default:
    return ("No CI checks", "No check runs were synced for this PR yet.")
  }
}

/// "5 of 6 passed · 1 failing", "2 running · 3 passed", "3 reported · no CI".
func prChecksHeadline(checks: [PrCheck], overallChecksStatus: String?) -> (text: String, failing: Int, running: Int) {
  let stats = prChecksSummaryStats(checks: checks, overallChecksStatus: overallChecksStatus)
  if overallChecksStatus?.lowercased() == "not_run" {
    return ("\(stats.total) reported · no CI ran", stats.fail, stats.pending)
  }
  var parts = ["\(stats.pass) of \(stats.total) passed"]
  if stats.fail > 0 { parts.append("\(stats.fail) failing") }
  if stats.pending > 0 { parts.append("\(stats.pending) running") }
  if stats.skipped > 0 { parts.append("\(stats.skipped) skipped") }
  return (parts.joined(separator: " · "), stats.fail, stats.pending)
}

/// One coloured fragment of a checks tally.
struct PrChecksGroupSummaryPart: Equatable {
  enum Tone: Equatable { case fail, pending, pass, muted }
  let text: String
  let tone: Tone
}

enum PrCheckConclusionKind {
  case success, failure, pending, neutral
}

func prCheckConclusionKind(_ check: PrCheck) -> PrCheckConclusionKind {
  if check.status != "completed" { return .pending }
  switch check.conclusion {
  case "success": return .success
  case "failure", "timed_out", "cancelled", "action_required", "startup_failure": return .failure
  default: return .neutral
  }
}

private func prCheckGlyph(_ kind: PrCheckConclusionKind) -> (symbol: String, tint: Color) {
  switch kind {
  case .success: return ("checkmark.circle.fill", ADEColor.success)
  case .failure: return ("xmark.circle.fill", ADEColor.danger)
  case .pending: return ("clock.fill", ADEColor.warning)
  case .neutral: return ("minus.circle", ADEColor.textMuted)
  }
}

/// The job of an Actions run that produced `check`, matched by name.
func prActionJob(for check: PrCheck, in runs: [PrActionRun]) -> (run: PrActionRun, job: PrActionJob)? {
  let name = check.name.lowercased()
  for run in runs {
    if let job = run.jobs.first(where: { $0.name.lowercased() == name }) { return (run, job) }
  }
  for run in runs {
    if let job = run.jobs.first(where: { name.hasSuffix($0.name.lowercased()) || $0.name.lowercased().hasSuffix(name) }) {
      return (run, job)
    }
  }
  return nil
}

// MARK: - Tab rows

/// The Checks tab's sections, emitted as List sections.
struct PrChecksSections: View {
  let checks: [PrCheck]
  let overallChecksStatus: String?
  let checksReason: String?
  let missingRequired: [String]
  let actionRuns: [PrActionRun]
  let deployments: [PrDeployment]
  let canRerun: Bool
  let onRerun: () -> Void

  @State private var passedExpanded = false

  private var isNotRun: Bool { overallChecksStatus?.lowercased() == "not_run" }

  private var failing: [PrCheck] { checks.filter { prCheckConclusionKind($0) == .failure } }
  private var running: [PrCheck] { checks.filter { prCheckConclusionKind($0) == .pending } }
  private var finished: [PrCheck] {
    checks.filter { [.success, .neutral].contains(prCheckConclusionKind($0)) }
  }

  var body: some View {
    Group {
      Section {
        if checks.isEmpty {
          let copy = prChecksEmptyStateCopy(overallChecksStatus: overallChecksStatus, checksReason: checksReason)
          PrFlatEmptyRow(title: copy.title, message: copy.message)
            .adeFlatRow(separator: .hidden)
        } else {
          let headline = prChecksHeadline(checks: checks, overallChecksStatus: overallChecksStatus)
          HStack(spacing: 8) {
            Image(systemName: headline.failing > 0 ? "xmark.circle.fill" : headline.running > 0 ? "clock.fill" : "checkmark.circle.fill")
              .foregroundStyle(headline.failing > 0 ? ADEColor.danger : headline.running > 0 ? ADEColor.warning : (isNotRun ? ADEColor.textMuted : ADEColor.success))
              .font(.system(size: 13, weight: .semibold))
            Text(headline.text)
              .font(.subheadline.weight(.medium))
              .foregroundStyle(ADEColor.textPrimary)
            Spacer(minLength: 8)
            if canRerun && headline.failing > 0 {
              Button("Re-run", action: onRerun)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(ADEColor.accent)
                .buttonStyle(.plain)
            }
          }
          .adeFlatRow(separator: .hidden)
          if isNotRun {
            ADEFlatInlineNotice(message: checksReason ?? noCIReasonText, tint: ADEColor.textMuted)
              .adeFlatRow(separator: .hidden)
          }
        }
      }

      if !failing.isEmpty {
        Section {
          ForEach(failing) { row($0) }
        } header: { ADEFlatSectionHeader("Failing", detail: "\(failing.count)") }
      }
      if !running.isEmpty {
        Section {
          ForEach(running) { row($0) }
        } header: { ADEFlatSectionHeader("Running", detail: "\(running.count)") }
      }
      if !finished.isEmpty {
        Section {
          if passedExpanded {
            ForEach(finished) { row($0) }
          }
        } header: {
          Button {
            withAnimation(.snappy(duration: 0.2)) { passedExpanded.toggle() }
          } label: {
            ADEFlatSectionHeader(isNotRun ? "Reported" : "Passed", detail: "\(finished.count)") {
              Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(ADEColor.textMuted)
                .rotationEffect(.degrees(passedExpanded ? 90 : 0))
            }
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityValue(passedExpanded ? "Expanded" : "Collapsed")
        }
      }
      if !missingRequired.isEmpty {
        Section {
          ForEach(missingRequired, id: \.self) { context in
            HStack(spacing: 10) {
              Circle()
                .strokeBorder(ADEColor.textMuted, style: StrokeStyle(lineWidth: 1.3, dash: [2.2, 2.6]))
                .frame(width: 13, height: 13)
              Text(context).font(.subheadline).foregroundStyle(ADEColor.textPrimary).lineLimit(1)
              Spacer(minLength: 8)
              Text("never reported").font(.caption).foregroundStyle(ADEColor.textMuted)
            }
            .adeFlatRow()
          }
        } header: { ADEFlatSectionHeader("Required, missing", detail: "\(missingRequired.count)") }
      }
      if !deployments.isEmpty {
        Section {
          ForEach(deployments) { deployment in
            PrDeploymentFlatRow(deployment: deployment).adeFlatRow()
          }
        } header: { ADEFlatSectionHeader("Deployments", detail: "\(deployments.count)") }
      }
    }
  }

  private func row(_ check: PrCheck) -> some View {
    NavigationLink {
      PrCheckPage(check: check, match: prActionJob(for: check, in: actionRuns))
    } label: {
      PrCheckRow(check: check)
    }
    .adeFlatRow()
  }
}

struct PrCheckRow: View {
  let check: PrCheck

  var body: some View {
    let glyph = prCheckGlyph(prCheckConclusionKind(check))
    HStack(spacing: 10) {
      Image(systemName: glyph.symbol)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(glyph.tint)
        .frame(width: 18)
      Text(check.name)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .truncationMode(.middle)
      Spacer(minLength: 8)
      if let duration = prDurationText(startedAt: check.startedAt, completedAt: check.completedAt) {
        Text(duration).font(.adeMono(11)).foregroundStyle(ADEColor.textMuted)
      } else if check.status != "completed" {
        ProgressView().controlSize(.mini)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(check.name), \(prCheckStatusLabel(check))")
  }
}

private struct PrDeploymentFlatRow: View {
  let deployment: PrDeployment

  private var tint: Color {
    switch deployment.state.lowercased() {
    case "success", "active": return ADEColor.success
    case "failure", "error": return ADEColor.danger
    case "pending", "queued", "in_progress": return ADEColor.warning
    default: return ADEColor.textMuted
    }
  }

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "shippingbox")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(tint)
        .frame(width: 18)
      Text(deployment.environment).font(.subheadline).foregroundStyle(ADEColor.textPrimary).lineLimit(1)
      Text(verbatim: String(deployment.sha.prefix(7))).font(.adeMono(11)).foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 8)
      Text(deployment.state.lowercased()).font(.caption).foregroundStyle(tint)
    }
    .contentShape(Rectangle())
    .onTapGesture {
      if let raw = deployment.environmentUrl ?? deployment.logUrl, let url = URL(string: raw) {
        UIApplication.shared.open(url)
      }
    }
  }
}

/// One check: status, timing, the Actions job's steps when ADE has them, and
/// the log on GitHub.
struct PrCheckPage: View {
  let check: PrCheck
  let match: (run: PrActionRun, job: PrActionJob)?

  private var logURL: URL? {
    if let raw = check.detailsUrl, let url = URL(string: raw) { return url }
    if let match, let url = URL(string: match.run.htmlUrl) { return url }
    return nil
  }

  var body: some View {
    List {
      Section {
        VStack(alignment: .leading, spacing: 6) {
          PrCheckRow(check: check)
          HStack(spacing: 6) {
            Text(prCheckStatusLabel(check))
            if let started = check.startedAt {
              Text("· started \(prRelativeTime(started))")
            }
          }
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
        }
        .adeFlatRow(separator: .hidden)
      }
      if let match {
        Section {
          ForEach(match.job.steps) { step in
            HStack(spacing: 10) {
              Text(verbatim: "\(step.number)")
                .font(.adeMono(11))
                .foregroundStyle(ADEColor.textMuted)
                .frame(width: 22, alignment: .trailing)
              let glyph = prCheckGlyph(prCheckConclusionKind(PrCheck(name: step.name, status: step.status, conclusion: step.conclusion)))
              Image(systemName: glyph.symbol)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(glyph.tint)
              Text(step.name).font(.footnote).foregroundStyle(ADEColor.textPrimary).lineLimit(2)
              Spacer(minLength: 8)
              if let duration = prDurationText(startedAt: step.startedAt, completedAt: step.completedAt) {
                Text(duration).font(.adeMono(10.5)).foregroundStyle(ADEColor.textMuted)
              }
            }
            .adeFlatRow()
          }
        } header: {
          ADEFlatSectionHeader("Steps", detail: match.run.name)
        }
      }
      if let logURL {
        Section {
          Link(destination: logURL) {
            Label("Open log on GitHub", systemImage: "arrow.up.right.square")
              .font(.subheadline.weight(.medium))
              .foregroundStyle(ADEColor.accent)
          }
          .adeFlatRow(separator: .hidden)
        }
      }
    }
    .adeFlatList()
    .navigationTitle(check.name)
    .navigationBarTitleDisplayMode(.inline)
  }
}
