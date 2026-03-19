import SwiftUI

struct LanesTabView: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var lanes: [LaneSummary] = []
  @State private var errorMessage: String?
  @State private var createPresented = false

  private var activeLanes: [LaneSummary] {
    lanes.filter { $0.archivedAt == nil }
  }

  private var archivedLanes: [LaneSummary] {
    lanes.filter { $0.archivedAt != nil }
  }

  var body: some View {
    NavigationStack {
      List {
        if let errorMessage {
          Section {
            Text(errorMessage)
              .foregroundStyle(.red)
          }
        }

        Section("Active") {
          ForEach(activeLanes) { lane in
            NavigationLink {
              LaneDetailView(lane: lane)
            } label: {
              LaneRowView(lane: lane)
            }
            .swipeActions {
              Button("Archive", role: .destructive) {
                Task {
                  try? await syncService.archiveLane(lane.id)
                  try? await syncService.refreshLaneSnapshots()
                  await reload()
                }
              }
            }
          }
        }

        if !archivedLanes.isEmpty {
          Section("Archived") {
            ForEach(archivedLanes) { lane in
              NavigationLink {
                LaneDetailView(lane: lane)
              } label: {
                LaneRowView(lane: lane)
              }
              .swipeActions {
                Button("Restore") {
                  Task {
                    try? await syncService.unarchiveLane(lane.id)
                    try? await syncService.refreshLaneSnapshots()
                    await reload()
                  }
                }
                .tint(.green)
              }
            }
          }
        }
      }
      .navigationTitle("Lanes")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            createPresented = true
          } label: {
            Image(systemName: "plus")
          }
        }
      }
      .refreshable {
        await reload(refreshRemote: true)
      }
      .task {
        await reload(refreshRemote: true)
      }
      .task(id: syncService.localStateRevision) {
        await reload()
      }
      .sheet(isPresented: $createPresented) {
        CreateLaneView { name, description in
          Task {
            try? await syncService.createLane(name: name, description: description)
            try? await syncService.refreshLaneSnapshots()
            createPresented = false
            await reload()
          }
        }
      }
    }
  }

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    do {
      if refreshRemote {
        try? await syncService.refreshLaneSnapshots()
      }
      lanes = try await syncService.fetchLanes(includeArchived: true)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

private struct LaneRowView: View {
  let lane: LaneSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(lane.name)
          .font(.headline)
        Spacer()
        if lane.status.dirty {
          Label("Dirty", systemImage: "pencil.line")
            .font(.caption)
            .foregroundStyle(.orange)
        } else if lane.archivedAt != nil {
          Label("Archived", systemImage: "archivebox")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      Text(lane.branchRef)
        .font(.caption)
        .foregroundStyle(.secondary)
      HStack(spacing: 12) {
        Label("\(lane.status.ahead)", systemImage: "arrow.up")
        Label("\(lane.status.behind)", systemImage: "arrow.down")
        Label("\(lane.childCount)", systemImage: "square.stack.3d.up")
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
  }
}

private struct LaneDetailView: View {
  let lane: LaneSummary

  var body: some View {
    List {
      Section("Branch") {
        Text(lane.branchRef)
        Text("Base: \(lane.baseRef)")
          .foregroundStyle(.secondary)
      }
      Section("Status") {
        Label("Dirty: \(lane.status.dirty ? "yes" : "no")", systemImage: lane.status.dirty ? "exclamationmark.circle" : "checkmark.circle")
        Label("Ahead: \(lane.status.ahead)", systemImage: "arrow.up")
        Label("Behind: \(lane.status.behind)", systemImage: "arrow.down")
        Label("Children: \(lane.childCount)", systemImage: "square.stack.3d.up")
      }
      Section("Paths") {
        Text(lane.worktreePath)
          .font(.footnote.monospaced())
      }
    }
    .navigationTitle(lane.name)
  }
}

private struct CreateLaneView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var description = ""
  let onCreate: (String, String) -> Void

  var body: some View {
    NavigationStack {
      Form {
        TextField("Lane name", text: $name)
        TextField("Description", text: $description, axis: .vertical)
      }
      .navigationTitle("Create lane")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Create") {
            onCreate(name, description)
          }
          .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
  }
}
