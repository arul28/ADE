import SwiftUI

/// The five pickers a plugin page may ask ADE to open, drawn with the phone's
/// OWN controls.
///
/// The rule this file exists to keep: a page asking for a model picker gets the
/// model picker the reader already knows — the same Favorites rail, the same
/// provider tabs, the same rows — rather than a second list that looks like
/// ADE's and drifts from it. Every arm below either presents an existing view
/// (`WorkModelPickerSheet`, `WorkLanePickerMenu`) or reads an existing option
/// source (`workRuntimeModeOptions`, `workVisibleReasoningEfforts`,
/// `workProviderOptions`). Nothing here invents a list.
///
/// Dismissal versus refusal is decided BEFORE this view: a picker with nothing
/// to choose from is refused by the coordinator with a sentence, so this view
/// never draws an empty sheet. Closing it is a real answer — `nil`, which the
/// page reads as "the reader dismissed it".

struct PluginPagePickerSheet: View {
    let request: PluginPagePickerRequest
    /// Lanes the coordinator read before presenting, so the sheet never waits
    /// on a database call while it is being drawn.
    let lanes: [LaneSummary]
    let syncService: SyncService
    let onAnswer: (PluginPagePickerAnswer?) -> Void

    var body: some View {
        switch request.kind {
        case .model:
            WorkModelPickerSheet(
                // `value` preselects, so a page reopening its launch form finds
                // the picker on the reader's last choice.
                currentModelId: request.value ?? "",
                currentProvider: "",
                // Nil is ADE's whole catalogue; an empty array would be a
                // picker with nothing in it, which is a different instruction.
                availableModelIds: request.availableModelIds,
                isBusy: false,
                onSelect: { option, _, _, fastMode in
                    // Both halves of the one gesture: ADE's picker chooses a
                    // model AND whether it runs fast, and a page handed only
                    // the id would silently drop half of what the reader did.
                    onAnswer(.model(modelId: option.id, fastMode: fastMode))
                }
            )
            .environmentObject(syncService)
        case .lane:
            PluginPageLanePicker(lanes: lanes, selectedLaneId: request.value ?? "", onAnswer: onAnswer)
        case .permissionMode:
            PluginPageOptionPicker(
                title: "Permission mode",
                options: workRuntimeModeOptions(provider: request.provider ?? "")
                    .map { PluginPageOptionPicker.Option(id: $0.id, title: $0.title, subtitle: nil) },
                selectedId: request.value,
                onAnswer: { unified in
                    guard let unified else {
                        onAnswer(nil)
                        return
                    }
                    let provider = request.provider ?? ""
                    let choice = pluginPagePermissionModeChoice(provider: provider, mode: unified)
                    onAnswer(.permissionMode(
                        provider: provider,
                        field: choice.field,
                        value: choice.value
                    ))
                }
            )
        case .reasoningEffort:
            PluginPageOptionPicker(
                title: "Reasoning effort",
                // The "no reasoning" row first, because `effort: null` is a real
                // answer the ladder has to be able to express — a page cannot
                // turn reasoning off through a list that only offers levels.
                options: [PluginPageOptionPicker.Option(
                    id: PluginPagePickerSheet.noReasoningOptionId,
                    title: "No reasoning",
                    subtitle: "Run this model without a reasoning budget"
                )] + pluginPageReasoningEfforts(
                    provider: request.provider ?? "",
                    modelId: request.model ?? ""
                ).map {
                    PluginPageOptionPicker.Option(
                        id: $0.effort,
                        title: $0.effort.capitalized,
                        subtitle: $0.description
                    )
                },
                selectedId: request.value,
                onAnswer: { effort in
                    guard let effort else {
                        onAnswer(nil)
                        return
                    }
                    onAnswer(.reasoningEffort(
                        modelId: request.model ?? "",
                        effort: effort == PluginPagePickerSheet.noReasoningOptionId ? nil : effort
                    ))
                }
            )
        case .provider:
            PluginPageOptionPicker(
                title: "Provider",
                options: workProviderOptions().map {
                    PluginPageOptionPicker.Option(
                        id: $0.id,
                        title: $0.title,
                        subtitle: $0.subtitle,
                        icon: $0.icon,
                        tint: $0.tint
                    )
                },
                selectedId: request.value,
                onAnswer: { value in onAnswer(value.map { .provider($0) }) }
            )
        }
    }

    /// The row that answers `effort: null`.
    ///
    /// A sentinel rather than an empty string, so it cannot collide with a real
    /// effort a runtime might one day advertise, and so a page never receives
    /// this string — it is turned back into `null` before the answer is built.
    static let noReasoningOptionId = "__ade_no_reasoning__"
}

/// The native permission mode a chosen unified mode means, and the launch
/// argument it belongs in.
///
/// Derived FROM `workRuntimeWireFields` rather than from a second table written
/// here, which is the whole point of the pair travelling together: the phone
/// already owns one mapping from a unified mode to what the host is actually
/// sent, and a page must not end up holding a provider→field table of its own
/// that goes stale when a sixth provider arrives.
///
/// Each provider sets at most ONE of the provider-specific fields, so the order
/// below is a lookup rather than a precedence: Claude names
/// `claudePermissionMode`, OpenCode `opencodePermissionMode`, Droid
/// `droidPermissionMode`, Cursor `cursorModeId`. Codex and Pi express their
/// permission through the unified field itself, so that is the field they
/// honestly report.
func pluginPagePermissionModeChoice(
    provider: String,
    mode: String
) -> (field: String, value: String) {
    let fields = workRuntimeWireFields(provider: provider, mode: mode)
    if let value = fields.claudePermissionMode { return ("claudePermissionMode", value) }
    if let value = fields.opencodePermissionMode { return ("opencodePermissionMode", value) }
    if let value = fields.droidPermissionMode { return ("droidPermissionMode", value) }
    if let value = fields.cursorModeId { return ("cursorModeId", value) }
    if let value = fields.permissionMode { return ("permissionMode", value) }
    // A provider this build has no wire mapping for: the unified mode is the
    // only thing that is true about the choice, reported under the field every
    // host reads it from.
    return ("permissionMode", mode)
}

/// The efforts a model actually offers, from the phone's own catalog.
///
/// Read through `workModelCatalogGroups` rather than from a table written here,
/// because that function already folds together what the paired machine
/// advertised and what ADE curates — a page offering `xhigh` for a model the
/// host never advertised it for would produce a launch the runtime refuses.
///
/// Empty means this model has no reasoning knob, which the coordinator turns
/// into a REFUSAL rather than an empty sheet: "there is nothing to choose" and
/// "the reader chose nothing" are different answers.
func pluginPageCatalogModel(provider: String, modelId: String) -> WorkModelOption? {
    let trimmed = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    for group in workModelCatalogGroups(currentModelId: trimmed, currentProvider: provider) {
        for providerGroup in group.providers {
            for model in providerGroup.models where workModelIdsEquivalent(model.id, trimmed) {
                return model
            }
        }
    }
    return nil
}

func pluginPageModelIsInCatalog(provider: String, modelId: String) -> Bool {
    pluginPageCatalogModel(provider: provider, modelId: modelId) != nil
}

func pluginPageReasoningEfforts(provider: String, modelId: String) -> [AgentChatModelReasoningEffort] {
    pluginPageCatalogModel(provider: provider, modelId: modelId)?.reasoningEfforts ?? []
}

// MARK: - Lane

/// The phone's own lane menu, presented as a sheet.
///
/// `showsAutoCreateOption` is off, deliberately: the auto-create row answers
/// with a sentinel id that is not a lane, and a page handed that string would
/// send it to the host as a lane id and get a refusal it cannot explain.
private struct PluginPageLanePicker: View {
    let lanes: [LaneSummary]
    let selectedLaneId: String
    let onAnswer: (PluginPagePickerAnswer?) -> Void

    @State private var searchQuery = ""

    private var filtered: [LaneSummary] {
        let trimmed = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { return lanes }
        return lanes.filter {
            $0.name.lowercased().contains(trimmed)
                || $0.branchRef.lowercased().contains(trimmed)
        }
    }

    var body: some View {
        NavigationStack {
            WorkLanePickerMenu(
                lanes: filtered,
                allLanesEmpty: lanes.isEmpty,
                selectedLaneId: selectedLaneId,
                showsAutoCreateOption: false,
                searchQuery: $searchQuery,
                onSelect: { laneId in
                    guard let lane = lanes.first(where: { $0.id == laneId }) else {
                        onAnswer(nil)
                        return
                    }
                    // `name` is required on the wire, so it is never empty: a
                    // lane the reader can see in this list has something to
                    // call it, and an unnamed one falls back to its branch and
                    // then to its id rather than to a blank string a page would
                    // draw as an empty chip.
                    let name = [lane.name, lane.branchRef, lane.id]
                        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                        .first { !$0.isEmpty } ?? lane.id
                    onAnswer(.lane(laneId: lane.id, name: name))
                }
            )
            .navigationTitle("Choose a lane")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onAnswer(nil) }
                }
            }
        }
    }
}

// MARK: - A list of choices

/// One list, three pickers.
///
/// Permission mode, reasoning effort and provider are all "pick one of a short
/// closed list", and the phone draws them as menus rather than as screens. A
/// page cannot anchor a menu, so they become one sheet — with the SAME option
/// text the menus use, which is what keeps a plugin's launch form and ADE's own
/// composer saying the same words for the same setting.
private struct PluginPageOptionPicker: View {
    struct Option: Identifiable, Equatable {
        var id: String
        var title: String
        var subtitle: String?
        var icon: String?
        var tint: Color?
    }

    let title: String
    let options: [Option]
    /// The row `value` asked to preselect, if any. Drawn as a checkmark and
    /// nothing more: a picker that opened on a choice the reader made last time
    /// still has to be pressed, or dismissing it would look like agreeing.
    var selectedId: String?
    let onAnswer: (String?) -> Void

    var body: some View {
        NavigationStack {
            List {
                ForEach(options) { option in
                    Button {
                        onAnswer(option.id)
                    } label: {
                        HStack(spacing: 12) {
                            if let icon = option.icon {
                                Image(systemName: icon)
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundStyle(option.tint ?? ADEColor.accent)
                                    .frame(width: 28)
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.title)
                                    .font(.body)
                                    .foregroundStyle(ADEColor.textPrimary)
                                if let subtitle = option.subtitle, !subtitle.isEmpty {
                                    Text(subtitle)
                                        .font(.caption)
                                        .foregroundStyle(ADEColor.textSecondary)
                                }
                            }
                            Spacer(minLength: 0)
                            if option.id == selectedId {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(ADEColor.accent)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onAnswer(nil) }
                }
            }
        }
    }
}
