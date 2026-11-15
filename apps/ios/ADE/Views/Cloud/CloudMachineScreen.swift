import SwiftUI

// MARK: - One computer

struct CloudMachineScreen: View {
  @ObservedObject var store: CloudPaneStore
  let instanceId: String

  var body: some View {
    ScrollView {
      if let machine = store.machine(instanceId) {
        VStack(alignment: .leading, spacing: 16) {
          CloudMachineFacts(store: store, machine: machine)
          CloudDiskParts(machine: machine, now: store.now)
          CloudMachineControls(store: store, machine: machine)
        }
        .padding(16)
      } else {
        ADESettingsNotice(message: "That computer is gone. It was deleted, or its lane moved to a new one.", tone: .neutral)
          .padding(16)
      }
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .refreshable { await store.reload() }
    .navigationTitle(store.machine(instanceId)?.displayName ?? "Computer")
    .navigationBarTitleDisplayMode(.inline)
  }
}

struct CloudMachineFacts: View {
  @ObservedObject var store: CloudPaneStore
  let machine: CloudPhoneMachine

  var body: some View {
    let tier = cloudPhoneTier(of: machine, in: store.tiers)
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        ADEKitDot(tone: cloudStateTone(machine), size: 8)
        Text(machine.stateLabel).font(.headline)
        if let mark = cloudMachineMark(machine, idle: store.account?.dueForDeletion.first { $0.instanceId == machine.instanceId }, now: store.now) {
          ADEKitTag(text: mark.text, tone: mark.tone)
        }
      }
      Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
        if let lane = machine.lane {
          fact("Lane", lane.laneName)
          if let origin = lane.projectOrigin { fact("Repository", origin) }
        }
        if let tier {
          fact("Size", "\(tier.label)\(tier.full ? ", full computer" : "") · \(tier.cpu) CPU · \(cloudGbText(tier.memoryGb)) GB")
          fact("Uses", cloudHoursRate(tier.rate))
        } else if let size = machine.size {
          fact("Size", size)
          if let rate = machine.hoursRate { fact("Uses", cloudHoursRate(rate)) }
        }
        if let resources = machine.resources { fact("Disk", cloudGb(resources.diskGb)) }
        let lastRun = cloudLastRun(machine, now: store.now)
        if !lastRun.isEmpty { fact("Last run", lastRun) }
        if machine.pastDue == true { fact("State", "Suspended") }
      }
      .font(.subheadline)
      if machine.noLane {
        Text("Made before each lane had its own computer. It still counts toward your computers and disk.")
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let full = cloudPhoneWords(machine.diskFull) {
        ADESettingsNotice(message: full, tone: .warn)
      }
    }
    .adeKitCard()
  }

  private func fact(_ label: String, _ value: String) -> some View {
    GridRow {
      Text(label).foregroundStyle(ADEColor.textMuted)
      Text(value).foregroundStyle(ADEColor.textPrimary).lineLimit(2).truncationMode(.middle)
    }
  }
}

/// What uses the disk, as the computer last measured itself while awake.
/// ADE doesn't wake it to look.
struct CloudDiskParts: View {
  let machine: CloudPhoneMachine
  let now: Date

  var body: some View {
    if machine.resources != nil {
      ADEKitCard(
        title: "What uses the disk",
        symbol: "internaldrive",
        hint: machine.diskUsage.map { "Measured \(cloudAgo($0.measuredAt, now: now))" }
      ) {
        if let usage = machine.diskUsage, !usage.items.isEmpty {
          VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(usage.items.enumerated()), id: \.offset) { _, part in
              VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                  Text(part.label).font(.system(size: 13.5)).foregroundStyle(ADEColor.textPrimary).lineLimit(1)
                  if part.clearable == true { ADEKitTag(text: "Safe to clear", tone: .ok) }
                  Spacer(minLength: 4)
                  Text(cloudGb(part.gb)).font(.adeMono(12)).foregroundStyle(ADEColor.textSecondary)
                }
                ADEKitMeter(fraction: usage.totalGb > 0 ? part.gb / usage.totalGb : 0)
              }
            }
            Text("\(cloudGb(usage.totalGb)) used of \(cloudGb(machine.resources?.diskGb ?? 0))\(machine.isAwake ? "" : ". Asleep: its last measure.")")
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textMuted)
          }
        } else {
          Text("The computer measures its disk while it's awake and idle, at most every few hours. Its first measure shows here then.")
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }
}

/// What the phone can do with a computer: open its work, sleep or wake it,
/// and delete a computer that holds no lane. A lane's size, freeing its
/// computer and deleting the lane run the desktop's lane steps (its work is
/// pushed first), so they stay in the ADE desktop app.
struct CloudMachineControls: View {
  @ObservedObject var store: CloudPaneStore
  let machine: CloudPhoneMachine
  @State private var confirmDelete = false

  private var busy: Bool { store.busy.contains(machine.instanceId) || machine.isMoving }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ADEEyebrow("Actions")
      CloudFlowRow {
        if let key = machine.machineKey {
          Button {
            ADEHaptics.light()
            store.syncService.cloudPanePresented = false
            // Opened from Settings the page is in Settings' own stack;
            // closing Settings closes it too, so the work shows.
            store.syncService.settingsPresented = false
            Task { _ = await store.syncService.ensureAccountMachineForNavigation(key) }
          } label: {
            Label("Open its work", systemImage: "arrow.up.forward.app")
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true))
          .disabled(busy)
        }
        if store.canWrite {
          if machine.isAwake {
            Button { Task { await store.run("sleep", on: machine) } } label: { Label("Sleep now", systemImage: "moon") }
              .buttonStyle(ADEKitButtonStyle())
              .disabled(busy)
          } else if machine.isAsleep {
            Button { Task { await store.run("wake", on: machine) } } label: { Label("Wake", systemImage: "sun.max") }
              .buttonStyle(ADEKitButtonStyle())
              .disabled(busy || store.outOfHours)
          }
          if machine.noLane {
            Button(role: .destructive) { confirmDelete = true } label: { Label("Delete computer", systemImage: "trash") }
              .buttonStyle(ADEKitButtonStyle(tone: .crit))
              .disabled(busy)
          }
        }
      }
      Text(machine.noLane
        ? "Deleting it removes everything on its disk for good."
        : "Change its size, free its computer or delete the lane in the ADE desktop app: ADE pushes the lane's work first.")
        .font(.system(size: 12))
        .foregroundStyle(ADEColor.textMuted)
        .fixedSize(horizontal: false, vertical: true)
    }
    .confirmationDialog("Delete \(machine.displayName)?", isPresented: $confirmDelete, titleVisibility: .visible) {
      Button("Delete it", role: .destructive) { Task { await store.run("delete", on: machine) } }
    } message: {
      Text("Everything on its disk is gone for good: repos, lanes, and any work not pushed.")
    }
  }
}

struct CloudMachineChips: View {
  @ObservedObject var store: CloudPaneStore

  var body: some View {
    CloudFlowRow {
      ForEach(store.machines) { machine in
        Button {
          ADEHaptics.light()
          store.selectedId = machine.instanceId
        } label: {
          HStack(spacing: 6) {
            ADEKitDot(tone: cloudStateTone(machine))
            Text(machine.displayName).lineLimit(1)
          }
          .font(.subheadline)
          .padding(.horizontal, 12)
          .frame(minHeight: 44)
          .background(Capsule().fill(store.selected?.instanceId == machine.instanceId ? ADEColor.accent.opacity(0.16) : ADEKit.surface))
          .overlay(Capsule().stroke(ADEKit.edge))
        }
        .buttonStyle(.plain)
      }
    }
  }
}

struct CloudPickPrompt: View {
  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: "cloud").font(.system(size: 30)).foregroundStyle(ADEColor.textMuted)
      Text("Pick a lane or computer").font(.headline)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(ADEColor.pageBackground.ignoresSafeArea())
  }
}

/// Wraps its children onto as many rows as they need.
struct CloudFlowRow: Layout {
  var spacing: CGFloat = 8

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(.unspecified)
      if x > 0 && x + size.width > width {
        y += rowHeight + spacing
        x = 0
        rowHeight = 0
      }
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
      widest = max(widest, x - spacing)
    }
    return CGSize(width: proposal.width ?? widest, height: y + rowHeight)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(.unspecified)
      if x > bounds.minX && x + size.width > bounds.maxX {
        y += rowHeight + spacing
        x = bounds.minX
        rowHeight = 0
      }
      view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
  }
}
