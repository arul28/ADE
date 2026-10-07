import SwiftUI

let laneDeleteBatchConcurrency = 2

struct LaneBatchOperationResult<Value> {
  let laneId: String
  let result: Result<Value, Error>
}

func laneDeleteDependencyBatches(snapshots: [LaneListSnapshot]) -> [[String]] {
  let laneIds = snapshots.map(\.lane.id)
  let parentById = Dictionary(uniqueKeysWithValues: snapshots.compactMap { snapshot -> (String, String)? in
    guard let parentLaneId = snapshot.lane.parentLaneId else { return nil }
    return (snapshot.lane.id, parentLaneId)
  })
  var remaining = Set(laneIds)
  var batches: [[String]] = []

  while !remaining.isEmpty {
    let leafIds = laneIds.filter { laneId in
      guard remaining.contains(laneId) else { return false }
      return !laneIds.contains { candidateId in
        remaining.contains(candidateId) && parentById[candidateId] == laneId
      }
    }

    let batchIds = leafIds.isEmpty
      ? laneIds.first(where: { remaining.contains($0) }).map { [$0] } ?? []
      : leafIds
    guard !batchIds.isEmpty else { break }
    batches.append(batchIds)
    for laneId in batchIds {
      remaining.remove(laneId)
    }
  }

  return batches
}

@MainActor
func runLaneDeleteBatchWithConcurrency<Value>(
  laneIds: [String],
  concurrency: Int = laneDeleteBatchConcurrency,
  operation: @escaping (String) async throws -> Value
) async -> [LaneBatchOperationResult<Value>] {
  guard !laneIds.isEmpty else { return [] }

  let normalizedConcurrency = max(1, min(laneIds.count, min(concurrency, laneDeleteBatchConcurrency)))
  var results: [LaneBatchOperationResult<Value>] = []
  results.reserveCapacity(laneIds.count)

  var index = 0
  while index < laneIds.count {
    let nextIndex = min(index + normalizedConcurrency, laneIds.count)
    let chunk = Array(laneIds[index..<nextIndex])

    if chunk.count == 1 {
      results.append(await runLaneDeleteOperation(laneId: chunk[0], operation: operation))
    } else {
      async let first = runLaneDeleteOperation(laneId: chunk[0], operation: operation)
      async let second = runLaneDeleteOperation(laneId: chunk[1], operation: operation)
      results.append(contentsOf: await [first, second])
    }

    index = nextIndex
  }

  return results
}

@MainActor
private func runLaneDeleteOperation<Value>(
  laneId: String,
  operation: (String) async throws -> Value
) async -> LaneBatchOperationResult<Value> {
  do {
    return LaneBatchOperationResult(laneId: laneId, result: .success(try await operation(laneId)))
  } catch {
    return LaneBatchOperationResult(laneId: laneId, result: .failure(error))
  }
}

struct LaneBatchManageSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let snapshots: [LaneListSnapshot]
  let onComplete: @MainActor () async -> Void

  @State private var deleteMode: LaneDeleteMode = .worktree
  @State private var deleteRemoteName = "origin"
  @State private var deleteForce = false
  @State private var confirmText = ""
  @State private var errorMessage: String?
  @State private var busy = false

  private var laneIds: [String] {
    snapshots.map(\.lane.id)
  }

  private var archivableLaneIds: [String] {
    snapshots
      .map(\.lane)
      .filter { $0.archivedAt == nil && $0.laneType != "primary" }
      .map(\.id)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          LaneFormSection(title: "Selected lanes (\(laneIds.count))") {
            LaneChoiceList(items: snapshots) { snapshot in
              HStack(alignment: .center, spacing: 10) {
                WorkLaneLogoMark(
                  color: LaneColorPalette.displayColor(forHex: snapshot.lane.color, fallback: ADEColor.textSecondary),
                  laneIcon: snapshot.lane.icon,
                  size: 13
                )
                .frame(width: 18)
                VStack(alignment: .leading, spacing: 2) {
                  Text(snapshot.lane.name)
                    .font(.system(size: 14.5, weight: .medium))
                    .foregroundStyle(ADEColor.textPrimary)
                    .lineLimit(1)
                  Text(normalizedPrBranchName(snapshot.lane.branchRef))
                    .font(.adeMono(11))
                    .foregroundStyle(ADEColor.textMuted)
                    .lineLimit(1)
                }
                Spacer()
                if snapshot.lane.status.dirty {
                  ADEKitTag(text: "Dirty", tone: .warn)
                }
                if snapshot.lane.archivedAt != nil {
                  ADEKitTag(text: "Archived")
                }
              }
              .padding(.vertical, 8)
            }
          }

          LaneFormSection(title: "Archive") {
            Button {
              Task { await archiveSelected() }
            } label: {
              Label("Archive active lanes", systemImage: "archivebox")
            }
            .buttonStyle(ADEKitButtonStyle(tone: .warn, wide: true))
            .disabled(busy || archivableLaneIds.isEmpty)
          }

          LaneFormSection(title: "Delete") {
            VStack(alignment: .leading, spacing: 12) {
              LaneChoiceList(items: LaneDeleteMode.allCases) { mode in
                LaneChoiceRow(
                  title: mode.title,
                  subtitle: mode.detail,
                  systemImage: mode.symbol,
                  monoSubtitle: false,
                  isSelected: deleteMode == mode
                ) {
                  deleteMode = mode
                }
              }

              if deleteMode == .remoteBranch {
                LaneTextField("Remote name", text: $deleteRemoteName)
                  .textInputAutocapitalization(.never)
                  .autocorrectionDisabled()
              }

              Toggle("Force delete", isOn: $deleteForce)
                .font(.system(size: 14.5))
                .foregroundStyle(ADEColor.textPrimary)
                .tint(ADEColor.accent)

              LaneTextField("Type delete open lanes to confirm", text: $confirmText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

              Button(role: .destructive) {
                Task { await deleteSelected() }
              } label: {
                Label("Delete selected lanes", systemImage: "trash")
              }
              .buttonStyle(ADEKitButtonStyle(tone: .crit, wide: true))
              .disabled(confirmText.lowercased() != "delete open lanes" || busy || laneIds.isEmpty)
            }
          }

          if let errorMessage {
            ADESettingsNotice(message: errorMessage, tone: .crit)
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Manage lanes")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
            .disabled(busy)
        }
      }
    }
  }

  @MainActor
  private func archiveSelected() async {
    busy = true
    errorMessage = nil
    defer { busy = false }

    var archivedLaneIds: [String] = []
    var failures: [String] = []

    for laneId in archivableLaneIds {
      do {
        try await syncService.archiveLane(laneId)
        archivedLaneIds.append(laneId)
      } catch {
        failures.append("\(laneId) (\(error.localizedDescription))")
      }
    }

    if !archivedLaneIds.isEmpty {
      await onComplete()
    }

    if failures.isEmpty {
      dismiss()
      return
    }

    errorMessage = "Archived \(archivedLaneIds.count)/\(archivableLaneIds.count) active lanes. Failed: \(failures.joined(separator: "; "))"
  }

  @MainActor
  private func deleteSelected() async {
    busy = true
    errorMessage = nil
    defer { busy = false }

    var deletedLaneIds: [String] = []
    var failures: [String] = []

    let deleteBranch = deleteMode != .worktree
    let deleteRemoteBranch = deleteMode == .remoteBranch
    let remoteName = deleteRemoteName
    let force = deleteForce

    for batch in laneDeleteDependencyBatches(snapshots: snapshots) {
      let results = await runLaneDeleteBatchWithConcurrency(laneIds: batch) { laneId in
        try await syncService.deleteLane(
          laneId,
          deleteBranch: deleteBranch,
          deleteRemoteBranch: deleteRemoteBranch,
          remoteName: remoteName,
          force: force
        )
      }

      for result in results {
        switch result.result {
        case .success:
          deletedLaneIds.append(result.laneId)
        case .failure(let error):
          failures.append("\(result.laneId) (\(error.localizedDescription))")
        }
      }
    }

    if !deletedLaneIds.isEmpty {
      await onComplete()
    }

    if failures.isEmpty {
      dismiss()
      return
    }

    errorMessage = "Deleted \(deletedLaneIds.count)/\(laneIds.count) lanes. Failed: \(failures.joined(separator: "; "))"
  }
}
