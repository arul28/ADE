import SwiftUI

// MARK: - What agents may do

struct CloudLimitsScreen: View {
  @ObservedObject var store: CloudPaneStore

  private let presets: [(id: String, name: String, line: String, symbol: String)] = [
    ("ask", "Ask me", "Nothing costs money without your yes.", "checkmark.shield"),
    ("balanced", "Balanced", "Agents get what they need, within limits.", "scalemass"),
    ("hands_off", "Hands-off", "For big runs: many computers at once.", "airplane.departure"),
  ]

  var body: some View {
    List {
      Section {
        Text("When you're watching, agents ask first. These choose what an agent may do when nobody is: a full-auto chat or an automation.")
          .font(.subheadline).foregroundStyle(ADEColor.textSecondary)
      }
      .listRowBackground(Color.clear)
      Section {
        ForEach(presets, id: \.id) { preset in
          Button {
            ADEHaptics.light()
            Task { await store.setLimits(["preset": preset.id]) }
          } label: {
            HStack(spacing: 12) {
              Image(systemName: preset.symbol).frame(width: 28).foregroundStyle(ADEColor.accent)
              VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                  Text(preset.name).font(.subheadline.weight(.semibold)).foregroundStyle(ADEColor.textPrimary)
                  if preset.id == "balanced" {
                    Text("Recommended").font(.caption2).padding(.horizontal, 6).padding(.vertical, 1)
                      .background(Capsule().fill(ADEColor.accent.opacity(0.16))).foregroundStyle(ADEColor.accent)
                  }
                }
                Text(preset.line).font(.caption).foregroundStyle(ADEColor.textSecondary)
              }
              Spacer()
              if store.limits?.preset == preset.id { Image(systemName: "checkmark").foregroundStyle(ADEColor.accent) }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .disabled(!store.canWrite)
        }
      } header: { CloudSectionLabel("Choose") } footer: {
        if store.limits?.preset == "custom" { Text("Custom: your own limits below.") }
      }
      if let limits = store.limits {
        Section {
          Toggle("Unattended agents may spend", isOn: Binding(
            get: { limits.unattendedSpend },
            set: { value in Task { await store.setLimits(["unattendedSpend": value]) } }
          ))
          .disabled(!store.canWrite)
          Picker("New computers a day", selection: Binding(
            get: { limits.machinesPerDay },
            set: { value in Task { await store.setLimits(["machinesPerDay": value]) } }
          )) {
            ForEach([1, 3, 5, 10], id: \.self) { Text("\($0)").tag($0) }
          }
          .disabled(!limits.unattendedSpend || !store.canWrite)
          Picker("Largest size", selection: Binding(
            get: { limits.maxShape },
            set: { value in Task { await store.setLimits(["maxShape": value]) } }
          )) {
            ForEach(cloudShapes, id: \.id) { Text($0.label).tag($0.id) }
          }
          .disabled(!limits.unattendedSpend || !store.canWrite)
        } header: { CloudSectionLabel("Limits") }
      } else {
        Section { ProgressView().frame(maxWidth: .infinity) }
      }
      Section {
        Label("Always yours to decide: keeping a computer awake for good, raising these limits, and deleting a computer an agent didn't make.", systemImage: "lock.fill")
          .font(.caption).foregroundStyle(ADEColor.textSecondary)
      }
      .listRowBackground(Color.clear)
      if let error = store.actionError {
        Section { ADESettingsNotice(message: "That didn't save. \(error)", tone: .crit) }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .navigationTitle("What agents may do")
    .navigationBarTitleDisplayMode(.inline)
  }
}

struct CloudSectionLabel: View {
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text.uppercased()).font(.caption2.weight(.semibold)).tracking(0.6).foregroundStyle(ADEColor.textMuted)
  }
}
