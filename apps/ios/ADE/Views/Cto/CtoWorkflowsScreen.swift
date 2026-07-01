import SwiftUI

struct CtoWorkflowsScreen: View {
  @EnvironmentObject private var syncService: SyncService

  @State private var connection: LinearConnectionStatus?
  @State private var dashboard: LinearSyncDashboard?
  @State private var policy: LinearWorkflowConfig?
  @State private var events: [LinearIngressEventRecord] = []
  @State private var pickerData: LinearIssuePickerData?
  @State private var quickView: LinearQuickView?
  @State private var issues: [NormalizedLinearIssue] = []
  @State private var issueQuery = ""
  @State private var issueSearchError: String?
  @State private var isLoadingIssues = false
  @State private var selectedIssue: NormalizedLinearIssue?
  @State private var isLoading = false
  @State private var isSyncing = false
  @State private var errorMessage: String?
  @State private var syncNotice: String?
  @State private var showEditOnMachine = false

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
        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 6, trailing: 16))
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
          .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
      } else if let connection, !connection.connected {
        notConnectedCard
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
      } else if connection == nil, !isLoading,
        errorMessage == nil || syncService.connectionState.isHostUnreachable {
        notConnectedCard
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
      } else {
        connectedSections
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .adeScreenBackground()
    .adeNavigationGlass()
    .refreshable { await reload() }
    .task {
      guard connection == nil else { return }
      await reload()
    }
    .sheet(isPresented: $showEditOnMachine) {
      EditOnMachineSheet()
        .presentationDetents([.fraction(0.3), .medium])
    }
    .sheet(item: $selectedIssue) { issue in
      LinearIssueDetailSheet(issue: issue)
        .environmentObject(syncService)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
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
            .background(ADEColor.purpleAccent.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .glassEffect(in: .rect(cornerRadius: 10))
            .overlay(
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(ADEColor.purpleAccent.opacity(0.34), lineWidth: 0.6)
            )
          }
          .buttonStyle(.plain)
          .disabled(isSyncing || syncService.connectionState.isHostUnreachable)
          .accessibilityLabel("Sync Linear now")
          .accessibilityHint("Triggers an immediate Linear workflow intake and dispatch cycle.")
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 10, trailing: 16))
      }
    }

    if let dashboard {
      Section {
        QueueCounterRow(dashboard: dashboard)
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 12, trailing: 16))
      }
    }

    issueBrowserSection

    Section {
      SectionHeader(
        title: "Workflow definitions",
        rightLabel: policy.map { "\($0.workflows.count) workflows" }
      )
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
      .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 6, trailing: 16))

      if let policy, !policy.workflows.isEmpty {
        ForEach(policy.workflows) { workflow in
          WorkflowCard(workflow: workflow) { showEditOnMachine = true }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }
      } else {
        Text("No workflows defined yet.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .adeListCard()
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
      }
    }

    Section {
      SectionHeader(title: "Recent sync events", rightLabel: nil)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 6, trailing: 16))

      if events.isEmpty {
        Text("No recent events.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .adeListCard()
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
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
        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
      }
    }

    Section {
      Color.clear.frame(height: 40)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets())
    }
  }

  @ViewBuilder
  private var issueBrowserSection: some View {
    Section {
      SectionHeader(
        title: "Linear issues",
        rightLabel: issueBrowserRightLabel
      )
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
      .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 6, trailing: 16))

      LinearIssueSearchCard(
        query: $issueQuery,
        pickerSummary: pickerDataSummary,
        errorMessage: issueSearchError,
        isLoading: isLoadingIssues,
        onSearch: { Task { await loadIssues() } }
      )
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
      .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 6, trailing: 16))

      if isLoadingIssues && issues.isEmpty {
        ADECardSkeleton(rows: 2)
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
      } else if issues.isEmpty {
        Text("No matching issues.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .adeListCard()
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
      } else {
        ForEach(issues) { issue in
          Button {
            selectedIssue = issue
          } label: {
            LinearIssueRow(issue: issue)
          }
          .buttonStyle(.plain)
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }
      }
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
      Text("Connect from the ADE machine CTO Workflows tab.")
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
      await loadIssues()
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

    let connResult = await CtoWorkflowsResult { try await syncService.fetchLinearConnectionStatus() }
    if case .success(let value) = connResult {
      self.connection = value
    }

    let dashResult = await CtoWorkflowsResult { try await syncService.fetchLinearSyncDashboard() }
    if case .success(let value) = dashResult {
      self.dashboard = value
    }

    let policyResult = await CtoWorkflowsResult { try await syncService.fetchFlowPolicy() }
    if case .success(let value) = policyResult {
      self.policy = value
    }

    let eventsResult = await CtoWorkflowsResult { try await syncService.listLinearIngressEvents(limit: 20) }
    if case .success(let value) = eventsResult {
      self.events = value
    }

    let pickerResult = await CtoWorkflowsResult { try await syncService.fetchLinearIssuePickerData() }
    if case .success(let value) = pickerResult {
      self.pickerData = value
    }

    let queryIsEmpty = issueQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    var didLoadQuickView = false
    let quickResult = await CtoWorkflowsResult { try await syncService.fetchLinearQuickView() }
    if case .success(let value) = quickResult {
      didLoadQuickView = true
      self.quickView = value
      if queryIsEmpty {
        self.issues = quickViewIssueList(value)
        self.issueSearchError = nil
      }
    }

    if !didLoadQuickView || !queryIsEmpty {
      await loadIssues()
    }

    // Only surface a top-level error if the connection fetch itself failed —
    // once we know Linear isn't connected, dashboard/policy failures are
    // expected (the services aren't initialized) and shouldn't render as an
    // error card.
    if case .failure(let err) = connResult, self.connection == nil {
      self.errorMessage = (err as? LocalizedError)?.errorDescription ?? String(describing: err)
    }
  }

  private var pickerDataSummary: String? {
    guard let pickerData else { return nil }
    let parts = [
      pickerData.projects.isEmpty ? nil : "\(pickerData.projects.count) projects",
      pickerData.states.isEmpty ? nil : "\(pickerData.states.count) states",
      pickerData.users.isEmpty ? nil : "\(pickerData.users.count) users",
    ].compactMap { $0 }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  private var issueBrowserRightLabel: String? {
    if !issues.isEmpty { return "\(issues.count) shown" }
    if let quickView {
      let assigned = quickView.assignedIssues.count
      let recent = quickView.recentIssues.count
      if assigned > 0 || recent > 0 {
        return "\(assigned) assigned · \(recent) recent"
      }
    }
    return pickerDataSummary
  }

  private func quickViewIssueList(_ quickView: LinearQuickView) -> [NormalizedLinearIssue] {
    var seen: Set<String> = []
    var result: [NormalizedLinearIssue] = []
    for issue in quickView.assignedIssues + quickView.recentIssues {
      guard !seen.contains(issue.id) else { continue }
      seen.insert(issue.id)
      result.append(issue)
    }
    return result
  }

  private func loadIssues() async {
    guard !isLoadingIssues else { return }
    isLoadingIssues = true
    defer { isLoadingIssues = false }
    do {
      let query = issueQuery.trimmingCharacters(in: .whitespacesAndNewlines)
      let result = try await syncService.searchLinearIssues(
        LinearIssueSearchArgs(
          query: query.isEmpty ? nil : query,
          first: 20,
          includeArchived: false
        )
      )
      issues = result.issues
      issueSearchError = nil
    } catch {
      issueSearchError = error.localizedDescription
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

// MARK: - Linear issues

private struct LinearIssueSearchCard: View {
  @Binding var query: String
  let pickerSummary: String?
  let errorMessage: String?
  let isLoading: Bool
  let onSearch: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.purpleAccent)
        TextField("Search title, ID, label, or assignee", text: $query)
          .font(.system(size: 13))
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .submitLabel(.search)
          .onSubmit(onSearch)
        Button(action: onSearch) {
          if isLoading {
            ProgressView().controlSize(.mini)
          } else {
            Image(systemName: "arrow.right.circle.fill")
              .font(.system(size: 17, weight: .semibold))
          }
        }
        .buttonStyle(.plain)
        .foregroundStyle(ADEColor.purpleAccent)
        .accessibilityLabel("Search Linear issues")
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .background(ADEColor.glassBackground, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 11, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.5)
      )

      if let errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(ADEColor.warning)
          .fixedSize(horizontal: false, vertical: true)
      } else if let pickerSummary {
        Text(pickerSummary)
          .font(.system(size: 10.5, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .adeListCard()
  }
}

private struct LinearIssueRow: View {
  let issue: NormalizedLinearIssue

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(issue.identifier)
          .font(.system(size: 11, design: .monospaced).weight(.bold))
          .foregroundStyle(ADEColor.purpleAccent)
        Text(issue.title)
          .font(.system(size: 13.5, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
        Spacer(minLength: 0)
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }

      HStack(spacing: 6) {
        if let state = issue.stateName, !state.isEmpty {
          ADEStatusPill(text: state, tint: linearIssueStateTint(issue.stateType))
        }
        if let project = issue.projectName ?? issue.projectSlug, !project.isEmpty {
          MetaChip(text: project, symbol: "folder")
        }
        if let assignee = issue.assigneeName, !assignee.isEmpty {
          MetaChip(text: assignee, symbol: "person.crop.circle")
        }
        if issue.hasOpenBlockers == true {
          MetaChip(text: "blocked", symbol: "exclamationmark.triangle.fill", tint: ADEColor.warning)
        }
      }
    }
    .adeListCard()
  }
}

private struct MetaChip: View {
  let text: String
  let symbol: String
  var tint: Color = ADEColor.textSecondary

  var body: some View {
    Label(text, systemImage: symbol)
      .font(.system(size: 10.5, weight: .medium))
      .foregroundStyle(tint)
      .lineLimit(1)
      .padding(.horizontal, 7)
      .padding(.vertical, 4)
      .background(tint.opacity(0.10), in: Capsule())
  }
}

private struct LinearIssueDetailSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let issue: NormalizedLinearIssue

  @State private var comments: [LinearIssueComment] = []
  @State private var isLoadingComments = false
  @State private var commentsError: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          VStack(alignment: .leading, spacing: 8) {
            Text(issue.identifier)
              .font(.system(size: 12, design: .monospaced).weight(.bold))
              .foregroundStyle(ADEColor.purpleAccent)
            Text(issue.title)
              .font(.title3.weight(.bold))
              .foregroundStyle(ADEColor.textPrimary)
              .fixedSize(horizontal: false, vertical: true)
            if let description = issue.description, !description.isEmpty {
              Text(description)
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
          .adeListCard()

          VStack(alignment: .leading, spacing: 8) {
            MetaRow(key: "state", value: issue.stateName ?? issue.stateType ?? "Unknown")
            if let project = issue.projectName ?? issue.projectSlug {
              MetaRow(key: "project", value: project)
            }
            if let assignee = issue.assigneeName {
              MetaRow(key: "assignee", value: assignee)
            }
            if let priority = issue.priorityLabel ?? issue.priority.map({ "P\($0)" }) {
              MetaRow(key: "priority", value: priority)
            }
            if let updatedAt = issue.updatedAt, let relative = CtoWorkflowsRelativeTime.format(iso: updatedAt) {
              MetaRow(key: "updated", value: relative)
            }
          }
          .adeListCard()

          VStack(alignment: .leading, spacing: 10) {
            Text("Comments")
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textMuted)
              .textCase(.uppercase)
              .tracking(0.4)

            if isLoadingComments && comments.isEmpty {
              ADECardSkeleton(rows: 2)
            } else if let commentsError {
              Text(commentsError)
                .font(.subheadline)
                .foregroundStyle(ADEColor.warning)
            } else if comments.isEmpty {
              Text("No comments.")
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
            } else {
              VStack(spacing: 0) {
                ForEach(Array(comments.enumerated()), id: \.element.id) { idx, comment in
                  LinearIssueCommentRow(comment: comment)
                  if idx < comments.count - 1 {
                    Divider().background(ADEColor.glassBorder)
                  }
                }
              }
            }
          }
          .adeListCard()
        }
        .padding(16)
      }
      .adeScreenBackground()
      .navigationTitle(issue.identifier)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Done") { dismiss() }
        }
        if let urlString = issue.url, let url = URL(string: urlString) {
          ToolbarItem(placement: .topBarTrailing) {
            Link(destination: url) {
              Image(systemName: "arrow.up.right.square")
            }
            .accessibilityLabel("Open in Linear")
          }
        }
      }
      .task(id: issue.id) {
        await loadComments()
      }
    }
  }

  private func loadComments() async {
    guard !isLoadingComments else { return }
    isLoadingComments = true
    defer { isLoadingComments = false }
    do {
      comments = try await syncService.fetchLinearIssueComments(issueId: issue.id)
      commentsError = nil
    } catch {
      commentsError = error.localizedDescription
    }
  }
}

private struct LinearIssueCommentRow: View {
  let comment: LinearIssueComment

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(comment.userDisplayName ?? comment.userName ?? "Linear")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
        if let relative = CtoWorkflowsRelativeTime.format(iso: comment.createdAt) {
          Text(relative)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      Text(comment.body)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.vertical, 10)
  }
}

private func linearIssueStateTint(_ stateType: String?) -> Color {
  switch stateType?.lowercased() {
  case "completed", "done": return ADEColor.success
  case "started", "unstarted": return ADEColor.info
  case "backlog", "triage": return ADEColor.textSecondary
  case "canceled", "cancelled": return ADEColor.danger
  default: return ADEColor.purpleAccent
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

// MARK: - Edit on machine sheet

private struct EditOnMachineSheet: View {
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 18) {
      Image(systemName: "desktopcomputer")
        .font(.system(size: 36, weight: .semibold))
        .foregroundStyle(ADEColor.accent)
        .padding(.top, 24)
      Text("Edit on machine")
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)
      Text("Linear workflow authoring is available from ADE on your machine.")
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
    // Reuse the shared cached ISO8601 parser (fractional then fallback) instead of
    // allocating formatters per row/render.
    guard let date = prParsedDate(iso) else { return nil }
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
