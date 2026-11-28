import SwiftUI

// MARK: - Home machine

/// The home's name for the settings row: "Not chosen yet" before the person
/// picks one, else the record's name, or this machine's when the home is it.
@MainActor
func ctoHomeRowName(_ sync: SyncService) -> String {
  if sync.ctoHomeNeedsChoice { return "Not chosen yet" }
  if let name = nonEmptyTrimmed(sync.ctoHomeMachineName) { return name }
  if sync.ctoHomeMachineKey == nil { return sync.focusedMachineDisplayName }
  return "Another machine"
}

/// Records `option` as the CTO's home, then has that machine take the CTO from
/// its account copy, so its notes, routines and recent chat move with it.
/// Answers the confirmation line when the new home restored one, else nil.
@MainActor
func ctoChooseHome(_ option: WorkNewChatMachineOption, sync: SyncService) async throws -> String? {
  // The machine that is already the home has nothing to change or take.
  if !sync.ctoHomeNeedsChoice, option.machineKey == sync.ctoHomeMachineKey { return nil }
  let record = try await sync.setCtoHomeMachine(machineKey: option.machineKey, name: option.name)
  guard let adopted = await sync.adoptCtoAccountCopy(home: record, machineKey: option.machineKey),
        adopted.restored
  else { return nil }
  return "Moved from \(adopted.fromName ?? "the old machine"). Notes, routines and recent chat came along."
}

/// The CTO's one question — where it lives — as a full page: the first run on
/// a project with no home record, and a sheet over Settings when changing it.
///
/// There is no default, so the person picks one of their machines with a
/// checkout of this repository. ADE Cloud is offered as a home, never sold:
/// the iPhone app shows no price, links to no checkout and starts no computer
/// (App Store rule; the desktop makes it), so its row is never a pick.
struct CtoHomeChooser: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @EnvironmentObject private var machineFleet: MachineFleet

  let look: CtoAvatarLook?
  /// The CTO's name, for "Where should Nova live?".
  let name: String
  /// The home when changing it; nil on first run.
  var currentName: String? = nil
  /// Why nothing can be picked (no git origin), or nil.
  var blockedReason: String? = nil
  /// Records the pick. Answers the confirmation line when the new home took
  /// the CTO's account copy, else nil. Throws when it could not be saved.
  let onChoose: @MainActor (WorkNewChatMachineOption) async throws -> String?
  /// Leaves without a pick, when there is a way back. Nil on first run.
  var onCancel: (() -> Void)? = nil

  @State private var selectedId: String?
  @State private var saving = false
  @State private var errorText: String?
  @State private var confirmation: String?
  @State private var cloudPaid: Bool?

  private var sync: SyncService { syncPublishes.service }
  private var accent: Color { look.ctoAccent }
  private var changing: Bool { currentName != nil }
  private var options: [WorkNewChatMachineOption] {
    // ADE Cloud keeps its own one row below (`cloudRow`).
    workNewChatMachineOptions(syncService: sync, fleet: machineFleet).filter { !$0.isCloud }
  }
  private var selected: WorkNewChatMachineOption? { options.first { $0.id == selectedId } }
  /// ADE Cloud is an option only where the account has it on.
  private var cloudShown: Bool { sync.cloudAvailable && sync.cloudSupported }
  /// The machine already the home: nothing to save, nothing to take.
  private var sameAsCurrent: Bool {
    guard let selected, !sync.ctoHomeNeedsChoice else { return false }
    return selected.machineKey == sync.ctoHomeMachineKey
  }
  private var canConfirm: Bool {
    !saving && confirmation == nil && blockedReason == nil && selected != nil && !sameAsCurrent
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        header
        if let confirmation {
          ADESettingsNotice(message: confirmation, tone: .neutral)
            .padding(.top, 16)
        } else if let blockedReason {
          ADESettingsNotice(message: blockedReason, tone: .warn)
            .padding(.top, 16)
        } else {
          CtoSectionTitle(title: "Machines")
          ADESettingsRows {
            ForEach(options) { option in machineRow(option) }
            if cloudShown { cloudRow }
          }
          if let errorText {
            ADESettingsNotice(message: errorText, tone: .crit)
              .padding(.top, 12)
          }
          CtoPrimaryButton(title: confirmTitle, look: look, busy: saving) {
            Task { await confirm() }
          }
          .disabled(!canConfirm)
          .opacity(canConfirm || saving ? 1 : 0.5)
          .frame(maxWidth: .infinity)
          .padding(.top, 20)
        }
        Color.clear.frame(height: 28)
      }
      .padding(.horizontal, 20)
    }
    .scrollBounceBehavior(.basedOnSize)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .task {
      guard cloudShown, cloudPaid == nil else { return }
      cloudPaid = await sync.readCloudPlanIsPaid()
    }
  }

  private var header: some View {
    VStack(spacing: 10) {
      CtoAvatarView(
        look: look,
        state: confirmation == nil ? (changing ? .idle : .asleep) : .happy,
        size: 76,
        motion: .lazy
      )
      Text(changing ? "Move \(name)" : "Where should \(name) live?")
        .font(.system(.title2, design: .rounded).weight(.bold))
        .foregroundStyle(ADEColor.textPrimary)
        .multilineTextAlignment(.center)
      Text(changing
        ? "Notes, routines and the recent chat come along."
        : "Pick the machine that's usually on. It keeps \(name)'s notes and chat.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 10)
  }

  private func machineRow(_ option: WorkNewChatMachineOption) -> some View {
    let isSelected = selectedId == option.id
    let isCurrent = !sync.ctoHomeNeedsChoice && option.machineKey == sync.ctoHomeMachineKey
    return Button {
      selectedId = option.id
      ADEHaptics.light()
    } label: {
      HStack(spacing: 12) {
        Image(systemName: option.symbol)
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(isSelected ? accent : ADEColor.textSecondary)
          .frame(width: 24)
        VStack(alignment: .leading, spacing: 2) {
          Text(option.name)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if !option.isLive {
            Text("Offline")
              .font(.system(size: 12.5))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
        }
        Spacer(minLength: 8)
        if isCurrent {
          Text("Current")
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textMuted)
        }
        Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
          .font(.system(size: 18))
          .foregroundStyle(isSelected ? accent : ADEColor.textMuted)
      }
      .padding(.horizontal, ADEKit.inset)
      .padding(.vertical, 11)
      .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(option.isLive ? option.name : "\(option.name), offline")
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }

  /// ADE Cloud as a home: on the phone it explains, it never starts anything
  /// and never sells anything.
  private var cloudRow: some View {
    HStack(spacing: 12) {
      Image(systemName: "cloud")
        .font(.system(size: 15, weight: .medium))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 24)
      VStack(alignment: .leading, spacing: 2) {
        Text(Brand.cloudName)
          .font(.system(size: 15))
          .foregroundStyle(ADEColor.textPrimary)
        Text(cloudPaid == true ? "Set it up from \(Brand.name) on a computer" : "Needs a paid plan")
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
    .opacity(0.6)
    .accessibilityElement(children: .combine)
    .accessibilityHint("Made from \(Brand.name) on a computer, not on the iPhone")
  }

  private var confirmTitle: String {
    guard let selected else { return "Pick a machine" }
    if selected.machineKey == nil { return changing ? "Move it here" : "Use this machine" }
    return changing ? "Move to \(selected.name)" : "Use \(selected.name)"
  }

  @MainActor
  private func confirm() async {
    guard let selected, canConfirm else { return }
    saving = true
    errorText = nil
    defer { saving = false }
    // A pick is also a decision to keep that machine connected.
    if let key = selected.machineKey, !selected.isLive { machineFleet.keepLive(machineKey: key) }
    do {
      let note = try await onChoose(selected)
      ADEHaptics.success()
      if let note {
        confirmation = note
      } else {
        onCancel?()
      }
    } catch {
      ADEHaptics.error()
      errorText = ctoShortError(error, fallback: "Couldn't save the home machine")
    }
  }
}

/// The chooser over Settings: changing the home. A move that restored the
/// CTO's copy stays up with its one line; anything else closes at once.
struct CtoHomeChooserSheet: View {
  @Environment(\.dismiss) private var dismiss

  let look: CtoAvatarLook?
  let name: String
  let currentName: String?
  var blockedReason: String? = nil
  let onChoose: @MainActor (WorkNewChatMachineOption) async throws -> String?

  var body: some View {
    NavigationStack {
      CtoHomeChooser(
        look: look,
        name: name,
        currentName: currentName,
        blockedReason: blockedReason,
        onChoose: onChoose,
        onCancel: { dismiss() }
      )
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { dismiss() }
        }
      }
    }
    .tint(look.ctoAccent)
  }
}
