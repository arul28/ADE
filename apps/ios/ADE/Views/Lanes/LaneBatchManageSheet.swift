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
        VStack(spacing: 14) {
          GlassSection(title: "Selected lanes (\(laneIds.count))") {
            VStack(alignment: .leading, spacing: 8) {
              ForEach(snapshots) { snapshot in
                HStack(alignment: .center, spacing: 10) {
                  LaneStatusIndicator(bucket: snapshot.runtime.bucket, size: 8)
                  VStack(alignment: .leading, spacing: 2) {
                    Text(snapshot.lane.name)
                      .font(.subheadline.weight(.semibold))
                      .foregroundStyle(ADEColor.textPrimary)
                    Text(snapshot.lane.branchRef)
                      .font(.system(.caption, design: .monospaced))
                      .foregroundStyle(ADEColor.textSecondary)
                  }
                  Spacer()
                  if snapshot.lane.status.dirty {
                    LaneMicroChip(icon: "circle.fill", text: "Dirty", tint: ADEColor.warning)
                  }
                  if snapshot.lane.archivedAt != nil {
                    LaneMicroChip(icon: "archivebox.fill", text: "Archived", tint: ADEColor.textMuted)
                  }
                }
              }
            }
          }

          GlassSection(title: "Archive") {
            Button {
              Task { await archiveSelected() }
            } label: {
              HStack {
                Image(systemName: "archivebox.fill")
                Text("Archive active lanes")
                  .font(.subheadline.weight(.semibold))
                Spacer()
              }
              .foregroundStyle(ADEColor.warning)
              .padding(12)
              .background(ADEColor.warning.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
              .glassEffect(in: .rect(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .disabled(busy || archivableLaneIds.isEmpty)
          }

          GlassSection(title: "Delete") {
            VStack(alignment: .leading, spacing: 12) {
              LazyVStack(spacing: 8) {
                ForEach(LaneDeleteMode.allCases) { mode in
                  LaneOptionButton(
                    title: mode.title,
                    subtitle: mode.detail,
                    systemImage: mode.symbol,
                    isSelected: deleteMode == mode,
                    tint: ADEColor.danger
                  ) {
                    deleteMode = mode
                  }
                }
              }

              if deleteMode == .remoteBranch {
                LaneTextField("Remote name", text: $deleteRemoteName)
                  .textInputAutocapitalization(.never)
                  .autocorrectionDisabled()
              }

              Toggle("Force delete", isOn: $deleteForce)
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)

              LaneTextField("Type delete open lanes to confirm", text: $confirmText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

              Button(role: .destructive) {
                Task { await deleteSelected() }
              } label: {
                HStack {
                  Image(systemName: "trash.fill")
                  Text("Delete selected lanes")
                    .font(.subheadline.weight(.semibold))
                  Spacer()
                }
                .padding(12)
                .background(ADEColor.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .glassEffect(in: .rect(cornerRadius: 12))
              }
              .buttonStyle(.plain)
              .disabled(confirmText.lowercased() != "delete open lanes" || busy || laneIds.isEmpty)
            }
          }
          .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
              .stroke(ADEColor.danger.opacity(0.4), lineWidth: 1)
              .allowsHitTesting(false)
          )

          if let errorMessage {
            HStack(alignment: .top, spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
                .fixedSize(horizontal: false, vertical: true)
              Spacer(minLength: 0)
            }
            .adeGlassCard(cornerRadius: 12, padding: 12)
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
