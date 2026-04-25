import SwiftUI

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
  @State private var selectedTemplateId: String?
  @State private var branches: [GitBranchSummary] = []
  @State private var errorMessage: String?
  @State private var queuedNotice: String?
  @State private var busy = false
  @State private var envProgress: LaneEnvInitProgress?
  @State private var envPhase: EnvSetupPhase = .form
  @State private var envPolling = false
  @State private var envPollTask: Task<Void, Never>?

  private enum EnvSetupPhase {
    case form
    case progress
  }

  private var supportsTemplates: Bool {
    switch createMode {
    case .primary, .child, .importBranch: return true
    case .rescueUnstaged: return false
    }
  }

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
    if envPhase == .progress {
      envProgressContent
    } else {
      formContent
    }
  }

  @ViewBuilder
  private var envProgressContent: some View {
    ScrollView {
      VStack(spacing: 14) {
        LaneEnvInitProgressPanel(
          progress: envProgress,
          isPolling: envPolling,
          onDone: {
            envPollTask?.cancel()
            envPollTask = nil
            dismiss()
          }
        )
      }
      .padding(16)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle("Setting up lane")
    .navigationBarTitleDisplayMode(.inline)
    .interactiveDismissDisabled(envProgress?.overallStatus == "running")
    .onDisappear {
      envPollTask?.cancel()
      envPollTask = nil
    }
  }

  @ViewBuilder
  private var formContent: some View {
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: "Create lane", subtitle: createSubtitle) {
            VStack(alignment: .leading, spacing: 12) {
              LaneTextField("Lane name", text: $name)
              LaneTextField("Description", text: $description)
            }
          }
          .adeBorderBeam(
            cornerRadius: 16,
            duration: 14,
            strength: 0.55,
            lineWidth: 1.25,
            variant: .colorful,
            active: true
          )

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

          if supportsTemplates {
            GlassSection(title: "Template") {
              VStack(spacing: 8) {
                templateRow(id: nil, name: "None", description: "Skip environment setup.")
                ForEach(templates) { template in
                  templateRow(id: template.id, name: template.name, description: template.description)
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
      async let templatesTask = syncService.fetchLaneTemplates()
      async let defaultIdTask = syncService.fetchDefaultLaneTemplateId()
      let (loadedTemplates, defaultId) = try await (templatesTask, defaultIdTask)
      templates = loadedTemplates
      if let defaultId, loadedTemplates.contains(where: { $0.id == defaultId }) {
        selectedTemplateId = defaultId
      } else {
        selectedTemplateId = nil
      }
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
      ADEHaptics.error()
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

      if supportsTemplates, let templateId = selectedTemplateId {
        envProgress = nil
        envPhase = .progress
        busy = false
        startEnvProgress(laneId: created.id, templateId: templateId)
        return
      }

      dismiss()
    } catch let queuedError as QueuedRemoteCommandError {
      queuedNotice = queuedError.errorDescription
    } catch {
      ADEHaptics.error()
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

  @ViewBuilder
  private func templateRow(id: String?, name: String, description: String?) -> some View {
    let isSelected = (selectedTemplateId ?? "") == (id ?? "")
    Button {
      selectedTemplateId = id
    } label: {
      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 4) {
          Text(name)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          if let description, !description.isEmpty {
            Text(description)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(2)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer(minLength: 8)
        Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(isSelected ? ADEColor.accent : ADEColor.textMuted)
          .padding(.top, 1)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .adeGlassCard(cornerRadius: 12, padding: 12)
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(isSelected ? ADEColor.accent.opacity(0.55) : Color.clear, lineWidth: 1)
    )
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : [.isButton])
  }

  private func startEnvProgress(laneId: String, templateId: String) {
    envPollTask?.cancel()
    envPolling = true
    let task = Task { @MainActor in
      do {
        envProgress = try await syncService.applyLaneTemplate(laneId: laneId, templateId: templateId)
      } catch let queuedError as QueuedRemoteCommandError {
        queuedNotice = queuedError.errorDescription
        envPolling = false
        return
      } catch {
        ADEHaptics.error()
        errorMessage = error.localizedDescription
        envPolling = false
        return
      }

      while !Task.isCancelled {
        if let progress = envProgress, progress.overallStatus != "running" {
          break
        }
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        if Task.isCancelled { break }
        do {
          if let next = try await syncService.fetchLaneEnvStatus(laneId: laneId) {
            envProgress = next
            if next.overallStatus != "running" { break }
          }
        } catch {
          break
        }
      }
      envPolling = false
    }
    envPollTask = task
  }
}
