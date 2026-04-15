import SwiftUI

// MARK: - Create lane sheet

struct LaneCreateSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let primaryLane: LaneSummary?
  let lanes: [LaneSummary]
  let showsModePicker: Bool
  let onComplete: @MainActor (String) async -> Void

  @State private var name = ""
  @State private var description = ""
  @State private var createMode: LaneCreateMode
  @State private var selectedParentLaneId = ""
  @State private var selectedBaseBranch = ""
  @State private var selectedImportBranch = ""
  @State private var selectedRescueLaneId = ""
  @State private var templates: [LaneTemplate] = []
  @State private var selectedTemplateId = ""
  @State private var branches: [GitBranchSummary] = []
  @State private var errorMessage: String?
  @State private var queuedNotice: String?
  @State private var busy = false
  @State private var envProgress: LaneEnvInitProgress?

  init(
    primaryLane: LaneSummary?,
    lanes: [LaneSummary],
    initialMode: LaneCreateMode = .primary,
    showsModePicker: Bool = true,
    onComplete: @escaping @MainActor (String) async -> Void
  ) {
    self.primaryLane = primaryLane
    self.lanes = lanes
    self.showsModePicker = showsModePicker
    self.onComplete = onComplete
    _createMode = State(initialValue: initialMode)
  }

  var body: some View {
    Group {
      if showsModePicker {
        NavigationStack {
          content
        }
      } else {
        content
      }
    }
  }

  @ViewBuilder
  private var content: some View {
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: "Create lane", subtitle: createSubtitle) {
            VStack(alignment: .leading, spacing: 12) {
              LaneTextField("Lane name", text: $name)
              LaneTextField("Description", text: $description)
            }
          }

          GlassSection(title: showsModePicker ? "Mode" : modeSectionTitle) {
            VStack(alignment: .leading, spacing: 12) {
              if showsModePicker {
                Picker("Create mode", selection: $createMode) {
                  ForEach(LaneCreateMode.allCases) { mode in
                    Text(mode.title)
                      .tag(mode)
                      .accessibilityLabel(mode.fullTitle)
                  }
                }
                .pickerStyle(.segmented)
              }

              switch createMode {
              case .primary:
                VStack(alignment: .leading, spacing: 12) {
                  Picker("Base branch", selection: $selectedBaseBranch) {
                    ForEach(branches.filter { !$0.isRemote }) { branch in
                      Text(branch.isCurrent ? "\(branch.name) (current)" : branch.name).tag(branch.name)
                    }
                  }
                  .pickerStyle(.menu)
                  if branches.filter({ !$0.isRemote }).isEmpty {
                    Text("No local branches found.")
                      .font(.caption)
                      .foregroundStyle(ADEColor.textMuted)
                  }
                }
              case .child:
                VStack(alignment: .leading, spacing: 12) {
                  Picker("Parent lane", selection: $selectedParentLaneId) {
                    Text("Select parent lane…").tag("")
                    ForEach(lanes.filter { $0.archivedAt == nil }) { lane in
                      Text("\(lane.name) (\(lane.branchRef))").tag(lane.id)
                    }
                  }
                  .pickerStyle(.menu)
                }
              case .importBranch:
                VStack(alignment: .leading, spacing: 12) {
                  Picker("Existing branch", selection: $selectedImportBranch) {
                    Text("Select a branch…").tag("")
                    ForEach(branches) { branch in
                      Text(branch.isRemote ? "\(branch.name) (remote)" : branch.name).tag(branch.name)
                    }
                  }
                  .pickerStyle(.menu)
                  if branches.isEmpty {
                    Text("No branches found.")
                      .font(.caption)
                      .foregroundStyle(ADEColor.textMuted)
                  }
                  Picker("Base branch", selection: $selectedBaseBranch) {
                    ForEach(branches.filter { !$0.isRemote }) { branch in
                      Text(branch.isCurrent ? "\(branch.name) (current)" : branch.name).tag(branch.name)
                    }
                  }
                  .pickerStyle(.menu)
                }
              case .rescueUnstaged:
                VStack(alignment: .leading, spacing: 12) {
                  Picker("Source lane", selection: $selectedRescueLaneId) {
                    Text("Select lane").tag("")
                    ForEach(lanes.filter { $0.archivedAt == nil && $0.status.dirty }) { lane in
                      Text("\(lane.name) (\(lane.branchRef))").tag(lane.id)
                    }
                  }
                  .pickerStyle(.menu)
                  if lanes.filter({ $0.archivedAt == nil && $0.status.dirty }).isEmpty {
                    Text("No lanes with unstaged changes.")
                      .font(.caption)
                      .foregroundStyle(ADEColor.textMuted)
                  }
                }
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

          if let notice = queuedNotice {
            ADENoticeCard(
              title: "Queued on host",
              message: notice,
              icon: "arrow.trianglehead.2.clockwise.rotate.90",
              tint: ADEColor.warning,
              actionTitle: "Dismiss",
              action: { self.queuedNotice = nil }
            )
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
      .navigationTitle(showsModePicker ? "Create lane" : navigationTitleForMode)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(createActionTitle) {
            Task { await submit() }
          }
          .disabled(!canSubmit || busy)
        }
      }
      .task {
        await loadOptions()
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
        selectedImportBranch = primaryLane.branchRef
        selectedRescueLaneId = lanes.first(where: { $0.status.dirty && $0.laneType != "primary" })?.id
          ?? (primaryLane.status.dirty ? primaryLane.id : "")
      }
      if selectedRescueLaneId.isEmpty {
        selectedRescueLaneId = lanes.first(where: { $0.status.dirty && $0.laneType != "primary" })?.id
          ?? (lanes.first(where: { $0.status.dirty })?.id ?? "")
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
      switch createMode {
      case .primary:
        created = try await syncService.createLane(
          name: name,
          description: description,
          parentLaneId: nil,
          baseBranch: selectedBaseBranch
        )
      case .child:
        created = try await syncService.createChildLane(name: name, parentLaneId: selectedParentLaneId, description: description)
      case .importBranch:
        created = try await syncService.importBranch(
          branchRef: selectedImportBranch,
          name: name,
          description: description,
          baseBranch: selectedBaseBranch
        )
      case .rescueUnstaged:
        created = try await syncService.createFromUnstaged(sourceLaneId: selectedRescueLaneId, name: name, description: description)
      }
      await onComplete(created.id)
      dismiss()

      // Run post-create env setup after dismiss so errors don't block the sheet.
      do {
        let progress = selectedTemplateId.isEmpty
          ? try await syncService.initializeLaneEnvironment(laneId: created.id)
          : try await syncService.applyLaneTemplate(laneId: created.id, templateId: selectedTemplateId)
        envProgress = progress
      } catch let queuedError as QueuedRemoteCommandError {
        queuedNotice = queuedError.errorDescription
      } catch {
        errorMessage = error.localizedDescription
      }
    } catch let queuedError as QueuedRemoteCommandError {
      queuedNotice = queuedError.errorDescription
    } catch {
      errorMessage = error.localizedDescription
    }
    busy = false
  }

  private var canSubmit: Bool {
    let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    switch createMode {
    case .primary:
      return !trimmedName.isEmpty && !selectedBaseBranch.isEmpty
    case .child:
      return !trimmedName.isEmpty && !selectedParentLaneId.isEmpty
    case .importBranch:
      return !trimmedName.isEmpty && !selectedImportBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !selectedBaseBranch.isEmpty
    case .rescueUnstaged:
      return !trimmedName.isEmpty && !selectedRescueLaneId.isEmpty
    }
  }

  private var createActionTitle: String {
    switch createMode {
    case .primary:
      return "Create"
    case .child:
      return "Create child"
    case .importBranch:
      return "Import"
    case .rescueUnstaged:
      return "Rescue"
    }
  }

  private var createSubtitle: String {
    switch createMode {
    case .primary:
      return "Create a lane from the selected base branch."
    case .child:
      return "Create a lane under another ADE lane."
    case .importBranch:
      return "Import an existing branch into ADE."
    case .rescueUnstaged:
      return "Split unstaged work into a new lane."
    }
  }

  private var modeSectionTitle: String {
    switch createMode {
    case .primary: return "Base branch"
    case .child: return "Parent lane"
    case .importBranch: return "Branch to import"
    case .rescueUnstaged: return "Source lane"
    }
  }

  private var navigationTitleForMode: String {
    switch createMode {
    case .primary: return "New lane"
    case .child: return "Child lane"
    case .importBranch: return "Import branch"
    case .rescueUnstaged: return "Rescue unstaged"
    }
  }
}
