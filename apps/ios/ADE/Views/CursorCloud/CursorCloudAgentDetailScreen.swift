import SwiftUI

/// Detail screen for one cloud agent: identity, run state, ownership, and the
/// action bar (Open in ADE / Stop / Pull into lane / Open on cursor.com).
/// Every action executes host-side through SyncService.
struct CursorCloudAgentDetailScreen: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let entry: CursorCloudFleetEntry

  @State private var busy = false
  @State private var message: String?
  @State private var successMessage: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        header
        factsCard
        let summary = entry.agent.summary
        if !summary.isEmpty && summary != entry.agent.name {
          VStack(alignment: .leading, spacing: 6) {
            sectionLabel("Summary")
            Text(summary)
              .font(.subheadline)
              .foregroundStyle(.primary.opacity(0.85))
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(14)
          .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.04)))
        }
        if let message {
          Text(message)
            .font(.caption)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.red.opacity(0.08)))
        }
        if let successMessage {
          Text(successMessage)
            .font(.caption)
            .foregroundStyle(.green)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.green.opacity(0.08)))
        }
      }
      .padding(16)
      .padding(.bottom, 96)
    }
    .scrollContentBackground(.hidden)
    .navigationTitle(entry.agent.name.isEmpty ? "Cloud agent" : entry.agent.name)
    .navigationBarTitleDisplayMode(.inline)
    .safeAreaInset(edge: .bottom) { actionBar }
  }

  // MARK: Sections

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        CursorCloudMark(size: 18)
        CursorCloudStatusChip(status: entry.displayStatus)
        Spacer()
        if let age = cursorCloudRelativeAge(entry.agent.lastActivityDate) {
          Text(age)
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }
      }
      Text(entry.agent.name.isEmpty ? String(entry.agent.agentId.prefix(14)) : entry.agent.name)
        .font(.title3.weight(.semibold))
    }
  }

  private var factsCard: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let branch = entry.branch {
        factRow("Branch", branch)
      } else if let repo = entry.agent.repos?.first {
        factRow("Repo", repo)
      }
      if let model = entry.modelId { factRow("Model", model) }
      if let lane = entry.ownership.laneName {
        factRow("Lane", lane)
      } else {
        factRow("Linked", "Unlinked — not started from an ADE chat")
      }
      if let issue = entry.ownership.linearIssueId { factRow("Linear", issue) }
      if entry.prUrl != nil { factRow("Pull request", "Available") }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(14)
    .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.04)))
  }

  private func factRow(_ label: String, _ value: String) -> some View {
    HStack(alignment: .top) {
      Text(label.uppercased())
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.secondary)
        .frame(width: 72, alignment: .leading)
      Text(value)
        .font(.caption)
        .textSelection(.enabled)
      Spacer(minLength: 0)
    }
  }

  private func sectionLabel(_ text: String) -> some View {
    Text(text.uppercased())
      .font(.caption2.weight(.semibold))
      .foregroundStyle(.secondary)
  }

  // MARK: Actions

  private var actionBar: some View {
    HStack(spacing: 8) {
      if !entry.agent.isArchived {
        Button {
          Task { await openInAde() }
        } label: {
          Text("Open in ADE")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(CursorCloudBrand.primary)
        .disabled(busy)
      }
      if entry.isActiveRun {
        Button(role: .destructive) {
          Task { await stop() }
        } label: {
          Label("Stop", systemImage: "stop.fill")
        }
        .buttonStyle(.bordered)
        .disabled(busy)
      }
      if entry.displayStatus == "finished" && !entry.agent.isArchived {
        Button {
          Task { await pull() }
        } label: {
          Label("Pull into lane", systemImage: "arrow.down.to.line")
        }
        .buttonStyle(.bordered)
        .disabled(busy)
      }
      if let webUrl = entry.agent.webUrl.flatMap(URL.init(string:)) {
        Link(destination: webUrl) {
          Image(systemName: "arrow.up.forward.square")
        }
        .buttonStyle(.bordered)
        .accessibilityLabel("Open on cursor.com")
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(.ultraThinMaterial)
  }

  // MARK: Host calls

  private func openInAde() async {
    busy = true
    message = nil
    successMessage = nil
    defer { busy = false }
    do {
      var laneName = entry.ownership.laneName
      let laneId: String
      if let linked = entry.ownership.laneId {
        laneId = linked
      } else {
        let resolved = try await syncService.resolveCursorCloudLane(agentId: entry.agent.agentId)
        laneId = resolved.laneId
        laneName = resolved.laneName
      }
      _ = try await syncService.openCursorCloudChat(
        agentId: entry.agent.agentId,
        laneId: laneId
      )
      successMessage = "Opened as a cloud chat in lane '\(laneName ?? "lane")' on your machine."
    } catch {
      message = error.localizedDescription
    }
  }

  private func stop() async {
    busy = true
    message = nil
    successMessage = nil
    defer { busy = false }
    do {
      let result = try await syncService.stopCursorCloudAgent(agentId: entry.agent.agentId)
      if (result["queued"] as? Bool) == true {
        message = "The stop request was queued on your machine — it will cancel shortly."
      } else if (result["stopped"] ?? true) == false {
        message = "The run could not be stopped on your machine."
      } else {
        successMessage = "Stop requested — the run is being cancelled."
      }
    } catch {
      message = error.localizedDescription
    }
  }

  private func pull() async {
    busy = true
    message = nil
    successMessage = nil
    defer { busy = false }
    do {
      let result = try await syncService.pullCursorCloudAgentIntoLane(agentId: entry.agent.agentId)
      successMessage = result.status == "created_lane"
        ? "Created lane '\(result.laneName)' and merged \(result.mergedBranch)."
        : "Merged \(result.mergedBranch) into '\(result.laneName)'."
    } catch {
      message = error.localizedDescription
    }
  }
}
