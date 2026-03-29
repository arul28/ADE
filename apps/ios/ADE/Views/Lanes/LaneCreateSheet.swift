import SwiftUI

// MARK: - Create lane sheet

struct LaneCreateSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let primaryLane: LaneSummary?
  let lanes: [LaneSummary]
  let onComplete: @MainActor (String) async -> Void

  @State private var name = ""
  @State private var description = ""
  @State private var createAsChild = false
  @State private var selectedParentLaneId = ""
  @State private var selectedBaseBranch = ""
  @State private var templates: [LaneTemplate] = []
  @State private var selectedTemplateId = ""
  @State private var branches: [GitBranchSummary] = []
  @State private var errorMessage: String?
  @State private var busy = false
  @State private var envProgress: LaneEnvInitProgress?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: "Create lane", subtitle: createAsChild ? "Branches from another ADE lane." : "Branches from the selected base.") {
            VStack(alignment: .leading, spacing: 12) {
              LaneTextField("Lane name", text: $name)
              LaneTextField("Description", text: $description)
            }
          }

          GlassSection(title: "Branching") {
            VStack(alignment: .leading, spacing: 12) {
              Toggle("Create as child lane", isOn: $createAsChild)
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)

              if createAsChild {
                Picker("Parent lane", selection: $selectedParentLaneId) {
                  Text("Select parent").tag("")
                  ForEach(lanes.filter { $0.archivedAt == nil }) { lane in
                    Text("\(lane.name) (\(lane.branchRef))").tag(lane.id)
                  }
                }
                .pickerStyle(.menu)
              } else {
                Picker("Base branch", selection: $selectedBaseBranch) {
                  ForEach(branches.filter { !$0.isRemote }) { branch in
                    Text(branch.name).tag(branch.name)
                  }
                }
                .pickerStyle(.menu)
              }
            }
          }

          GlassSection(title: "Template") {
            Picker("Template", selection: $selectedTemplateId) {
              Text("No template").tag("")
              ForEach(templates) { template in
                Text(template.name).tag(template.id)
              }
            }
            .pickerStyle(.menu)
          }

          if let envProgress {
            GlassSection(title: "Environment setup") {
              VStack(alignment: .leading, spacing: 10) {
                ForEach(envProgress.steps) { step in
                  HStack {
                    Text(step.label)
                      .font(.subheadline)
                      .foregroundStyle(ADEColor.textPrimary)
                    Spacer()
                    Text(step.status)
                      .font(.system(.caption, design: .monospaced))
                      .foregroundStyle(ADEColor.textSecondary)
                  }
                }
              }
            }
          }

          if let errorMessage {
            HStack(spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
              Spacer()
            }
            .padding(12)
            .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Create lane")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Create") {
            Task { await submit() }
          }
          .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (createAsChild && selectedParentLaneId.isEmpty) || busy)
        }
      }
      .task {
        await loadOptions()
      }
    }
  }

  @MainActor
  private func loadOptions() async {
    do {
      templates = try await syncService.fetchLaneTemplates()
      selectedTemplateId = try await syncService.fetchDefaultLaneTemplateId() ?? ""
      if let primaryLane {
        branches = try await syncService.listBranches(laneId: primaryLane.id)
        selectedBaseBranch = branches.first(where: { $0.isCurrent })?.name ?? branches.first?.name ?? primaryLane.branchRef
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func submit() async {
    do {
      busy = true
      errorMessage = nil
      let created: LaneSummary
      if createAsChild {
        created = try await syncService.createChildLane(name: name, parentLaneId: selectedParentLaneId, description: description)
      } else {
        created = try await syncService.createLane(
          name: name,
          description: description,
          parentLaneId: nil,
          baseBranch: selectedBaseBranch
        )
      }
      let progress = selectedTemplateId.isEmpty
        ? try await syncService.initializeLaneEnvironment(laneId: created.id)
        : try await syncService.applyLaneTemplate(laneId: created.id, templateId: selectedTemplateId)
      envProgress = progress
      await onComplete(created.id)
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
    busy = false
  }
}
