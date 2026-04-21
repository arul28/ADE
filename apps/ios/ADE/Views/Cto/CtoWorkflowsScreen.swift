import SwiftUI

struct CtoWorkflowsScreen: View {
  @EnvironmentObject private var syncService: SyncService

  @State private var connection: LinearConnectionStatus?
  @State private var dashboard: LinearSyncDashboard?
  @State private var policy: LinearWorkflowConfig?
  @State private var events: [LinearIngressEventRecord] = []
  @State private var isLoading = false
  @State private var isSyncing = false
  @State private var errorMessage: String?
  @State private var syncNotice: String?
  @State private var showEditOnDesktop = false

  var body: some View {
    List {
      if let errorMessage, !syncService.connectionState.isHostUnreachable {
        ADENoticeCard(
          title: "Workflows failed to load",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: "Retry",
          action: { Task { await reload() } }
        )
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 6, trailing: 0))
      }

      if let syncNotice {
        Section {
          Text(syncNotice)
            .font(.system(size: 11.5, design: .monospaced))
            .foregroundStyle(ADEColor.success)
            .frame(maxWidth: .infinity, alignment: .leading)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }
      }

      if isLoading && connection == nil && policy == nil {
        loadingSkeleton
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
      } else if let connection, !connection.connected {
        notConnectedCard
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
      } else if connection == nil, !isLoading,
        errorMessage == nil || syncService.connectionState.isHostUnreachable {
        notConnectedCard
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
      } else {
        connectedSections
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .adeScreenBackground()
    .refreshable { await reload() }
    .task {
      guard connection == nil else { return }
      await reload()
    }
    .sheet(isPresented: $showEditOnDesktop) {
      EditOnDesktopSheet()
        .presentationDetents([.fraction(0.3), .medium])
    }
  }

  @ViewBuilder
  private var connectedSections: some View {
    if let connection, connection.connected {
      Section {
        VStack(spacing: 8) {
          LinearConnectionStrip(status: connection)
          Button {
            Task { await syncNow() }
          } label: {
            HStack(spacing: 6) {
              if isSyncing {
                ProgressView().controlSize(.mini).tint(ADEColor.purpleAccent)
              } else {
                Image(systemName: "arrow.triangle.2.circlepath")
                  .font(.system(size: 12, weight: .semibold))
              }
              Text(isSyncing ? "Syncing…" : "Sync now")
                .font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(ADEColor.purpleAccent)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(ADEColor.purpleAccent.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(ADEColor.purpleAccent.opacity(0.3), lineWidth: 0.5)
            )
          }
          .buttonStyle(.plain)
          .disabled(isSyncing)
          .accessibilityLabel("Sync Linear now")
          .accessibilityHint("Triggers an immediate Linear workflow intake and dispatch cycle.")
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 10, trailing: 0))
      }
    }

    if let dashboard {
      Section {
        QueueCounterRow(dashboard: dashboard)
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 12, trailing: 0))
      }
    }

    Section {
      SectionHeader(
        title: "Workflow definitions",
        rightLabel: policy.map { "\($0.workflows.count) workflows" }
      )
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
      .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 6, trailing: 0))

      if let policy, !policy.workflows.isEmpty {
        ForEach(policy.workflows) { workflow in
          WorkflowCard(workflow: workflow) { showEditOnDesktop = true }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
        }
      } else {
        Text("No workflows defined yet.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .adeListCard()
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
      }
    }

    Section {
      SectionHeader(title: "Recent sync events", rightLabel: nil)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 6, trailing: 0))

      if events.isEmpty {
        Text("No recent events.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .adeListCard()
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
      } else {
        VStack(spacing: 0) {
          ForEach(Array(events.enumerated()), id: \.element.id) { idx, event in
            EventRow(event: event)
            if idx < events.count - 1 {
              Divider()
                .background(ADEColor.glassBorder)
                .padding(.leading, 14)
            }
          }
        }
        .adeListCard(padding: 0)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
      }
    }

    Section {
      Color.clear.frame(height: 40)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets())
    }
  }

  private var loadingSkeleton: some View {
    VStack(spacing: 12) {
      ADECardSkeleton(rows: 2)
      ADECardSkeleton(rows: 3)
      ADECardSkeleton(rows: 4)
    }
  }

  private var notConnectedCard: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Image(systemName: "link.badge.plus")
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(ADEColor.purpleAccent)
          .frame(width: 30, height: 30)
          .background(ADEColor.purpleAccent.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        Text("Linear not connected")
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
        Spacer()
      }
      Text("Connect from the desktop CTO Workflows tab.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .adeListCard()
    .overlay(
      RoundedRectangle(cornerRadius: ADEListRowMetrics.cornerRadius, style: .continuous)
        .stroke(ADEColor.purpleAccent.opacity(0.35), lineWidth: 0.75)
    )
  }

  private func syncNow() async {
    guard !isSyncing else { return }
    isSyncing = true
    syncNotice = nil
    defer { isSyncing = false }
    do {
      let updated = try await syncService.runLinearSyncNow()
      dashboard = updated
      syncNotice = "Sync completed · \(updated.queuedCount) queued, \(updated.runningCount) running."
      Task {
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        await MainActor.run { syncNotice = nil }
      }
    } catch {
      errorMessage = "Sync failed: \(error.localizedDescription)"
    }
  }

  /// Loads each read independently. Connection status is the gate for
  /// whether we show the "not connected" empty state vs the full UI; the
  /// other three reads are supplemental and degrade gracefully.
  private func reload() async {
    isLoading = true
    errorMessage = nil
    defer { isLoading = false }

    async let connR = CtoWorkflowsResult { try await syncService.fetchLinearConnectionStatus() }
    async let dashR = CtoWorkflowsResult { try await syncService.fetchLinearSyncDashboard() }
    async let policyR = CtoWorkflowsResult { try await syncService.fetchFlowPolicy() }
    async let eventsR = CtoWorkflowsResult { try await syncService.listLinearIngressEvents(limit: 20) }

    let (connResult, dashResult, policyResult, eventsResult) = await (connR, dashR, policyR, eventsR)

    if case .success(let value) = connResult { self.connection = value }
    if case .success(let value) = dashResult { self.dashboard = value }
    if case .success(let value) = policyResult { self.policy = value }
    if case .success(let value) = eventsResult { self.events = value }

    // Only surface a top-level error if the connection fetch itself failed —
    // once we know Linear isn't connected, dashboard/policy failures are
    // expected (the services aren't initialized) and shouldn't render as an
    // error card.
    if case .failure(let err) = connResult, self.connection == nil {
      self.errorMessage = (err as? LocalizedError)?.errorDescription ?? String(describing: err)
    }
  }
}

private func CtoWorkflowsResult<T>(_ body: @escaping () async throws -> T) async -> Result<T, Error> {
  do { return .success(try await body()) }
  catch { return .failure(error) }
}

// MARK: - Section header

private struct SectionHeader: View {
  let title: String
  let rightLabel: String?

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Text(title.uppercased())
        .font(.caption.weight(.semibold))
        .tracking(0.4)
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 8)
      if let rightLabel {
        Text(rightLabel)
          .font(.caption.weight(.medium))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 16)
  }
}

// MARK: - Connection strip

private struct LinearConnectionStrip: View {
  let status: LinearConnectionStatus

  var body: some View {
    HStack(spacing: 10) {
      ZStack {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(ADEColor.purpleAccent.opacity(0.18))
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(ADEColor.purpleAccent.opacity(0.35), lineWidth: 0.5)
        Image(systemName: "chart.line.uptrend.xyaxis")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.purpleAccent)
      }
      .frame(width: 28, height: 28)

      VStack(alignment: .leading, spacing: 1) {
        Text(titleText)
          .font(.system(size: 12.5, weight: .bold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Text(subtitleText)
          .font(.system(size: 9.5, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
      Spacer(minLength: 8)

      Circle()
        .fill(ADEColor.success)
        .frame(width: 7, height: 7)
        .shadow(color: ADEColor.success.opacity(0.6), radius: 4)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(
      LinearGradient(
        colors: [ADEColor.purpleAccent.opacity(0.14), ADEColor.purpleAccent.opacity(0.04)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      ),
      in: RoundedRectangle(cornerRadius: 13, style: .continuous)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 13, style: .continuous)
        .stroke(ADEColor.purpleAccent.opacity(0.25), lineWidth: 0.5)
    )
  }

  private var titleText: String {
    if let viewer = status.viewerName, !viewer.isEmpty { return "Linear · \(viewer)" }
    return "Linear"
  }

  private var subtitleText: String {
    var parts: [String] = []
    if let mode = status.authMode, !mode.isEmpty { parts.append(mode.uppercased()) }
    else { parts.append("OAuth") }
    if let ago = relativeLastSync { parts.append("synced \(ago)") }
    if let count = status.projectCount { parts.append("\(count) project\(count == 1 ? "" : "s")") }
    return parts.joined(separator: " · ")
  }

  private var relativeLastSync: String? {
    guard let raw = status.lastSyncAt else { return nil }
    return CtoWorkflowsRelativeTime.format(iso: raw).map { "\($0) ago" }
  }
}

// MARK: - Queue counters

private struct QueueCounterRow: View {
  let dashboard: LinearSyncDashboard

  var body: some View {
    HStack(spacing: 6) {
      QueueCounter(value: dashboard.queuedCount, label: "Queued", tint: ADEColor.textPrimary)
      QueueCounter(value: dashboard.runningCount, label: "Running", tint: ADEColor.info)
      QueueCounter(value: dashboard.completedCount, label: "Completed", tint: ADEColor.success)
    }
    .padding(.horizontal, 16)
  }
}

private struct QueueCounter: View {
  let value: Int
  let label: String
  let tint: Color

  var body: some View {
    VStack(spacing: 2) {
      Text("\(value)")
        .font(.system(size: 20, weight: .bold))
        .foregroundStyle(tint)
      Text(label.uppercased())
        .font(.system(size: 9, design: .monospaced).weight(.semibold))
        .tracking(1.2)
        .foregroundStyle(ADEColor.textMuted)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 9)
    .background(ADEColor.glassBackground, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    )
  }
}

// MARK: - Workflow card

private struct WorkflowCard: View {
  let workflow: LinearWorkflowDefinition
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 8) {
          Text(workflow.name)
            .font(.system(size: 13.5, weight: .bold))
            .foregroundStyle(ADEColor.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
          ADEStatusPill(
            text: workflow.enabled ? "on" : "off",
            tint: workflow.enabled ? ADEColor.success : ADEColor.textSecondary
          )
          Image(systemName: "chevron.right")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
        }

        VStack(alignment: .leading, spacing: 3) {
          MetaRow(key: "trigger", value: workflow.triggerDisplay)
          MetaRow(key: "target", value: workflow.targetDisplay)
          if let priority = workflow.priority {
            MetaRow(key: "priority", value: "\(priority)")
          }
        }
      }
      .adeListCard()
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

private struct MetaRow: View {
  let key: String
  let value: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text(key.uppercased())
        .font(.system(size: 9.5, design: .monospaced).weight(.semibold))
        .tracking(1.0)
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 64, alignment: .leading)
      Text(value)
        .font(.system(size: 10.5, design: .monospaced))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

// MARK: - Event row

private struct EventRow: View {
  let event: LinearIngressEventRecord

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Circle()
        .fill(dotColor)
        .frame(width: 6, height: 6)
        .shadow(color: dotColor.opacity(0.5), radius: 3)
        .padding(.top, 6)

      VStack(alignment: .leading, spacing: 1) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(event.displayIssueId)
            .font(.system(size: 11, design: .monospaced).weight(.bold))
            .foregroundStyle(ADEColor.purpleAccent)
          Text(kindDisplay)
            .font(.system(size: 12.5, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
        }
        if let summary = event.summary, !summary.isEmpty {
          Text(summary)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(2)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      if let stamp = event.displayTimestamp,
         let ago = CtoWorkflowsRelativeTime.format(iso: stamp) {
        Text(ago)
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .padding(.top, 1)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 11)
  }

  private var kindDisplay: String {
    let trimmed = event.kind.replacingOccurrences(of: "issue.", with: "")
    guard let first = trimmed.first else { return event.kind }
    return String(first).uppercased() + trimmed.dropFirst()
  }

  private var dotColor: Color {
    let k = event.kind.lowercased()
    if k.contains("dispatch") { return ADEColor.info }
    if k.contains("close") || k.contains("done") || k.contains("complete") { return ADEColor.success }
    if k.contains("reopen") || k.contains("fail") || k.contains("error") { return ADEColor.danger }
    if k.contains("comment") { return ADEColor.purpleAccent }
    return ADEColor.purpleAccent
  }
}

// MARK: - Edit on desktop sheet

private struct EditOnDesktopSheet: View {
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 18) {
      Image(systemName: "desktopcomputer")
        .font(.system(size: 36, weight: .semibold))
        .foregroundStyle(ADEColor.accent)
        .padding(.top, 24)
      Text("Edit on desktop")
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)
      Text("Linear workflow authoring is desktop-only for now.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 24)
      Button("Close") { dismiss() }
        .buttonStyle(.glassProminent)
        .padding(.top, 4)
      Spacer()
    }
    .frame(maxWidth: .infinity)
    .adeScreenBackground()
  }
}

// MARK: - Shared relative-time helper (file-private)

private enum CtoWorkflowsRelativeTime {
  static func format(iso: String) -> String? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    guard let date else { return nil }
    let seconds = Int(Date().timeIntervalSince(date))
    if seconds < 60 { return "\(max(seconds, 0))s" }
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h" }
    let days = hours / 24
    return "\(days)d"
  }
}
