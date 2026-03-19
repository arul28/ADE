import SwiftUI

struct ContentView: View {
  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 12) {
        Circle()
          .fill(statusColor)
          .frame(width: 10, height: 10)
        VStack(alignment: .leading, spacing: 2) {
          Text(statusTitle)
            .font(.headline)
          Text(syncService.hostName ?? "No host connected")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
        if syncService.pendingOperationCount > 0 {
          Text("\(syncService.pendingOperationCount) queued")
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
        }
        Button("Connect") {
          syncService.settingsPresented = true
        }
        .buttonStyle(.borderedProminent)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .background(Color(uiColor: .secondarySystemBackground))

      TabView {
        LanesTabView()
          .tabItem {
            Label("Lanes", systemImage: "square.stack.3d.up")
          }
        FilesTabView()
          .tabItem {
            Label("Files", systemImage: "doc.text")
          }
        WorkTabView()
          .tabItem {
            Label("Work", systemImage: "terminal")
          }
        PRsTabView()
          .tabItem {
            Label("PRs", systemImage: "arrow.triangle.pull")
          }
      }
      .tint(Color(red: 17 / 255, green: 94 / 255, blue: 89 / 255))
    }
    .sheet(isPresented: $syncService.settingsPresented) {
      ConnectionSettingsView()
        .environmentObject(syncService)
    }
  }

  private var statusTitle: String {
    switch syncService.connectionState {
    case .connected:
      return "Connected"
    case .connecting:
      return "Connecting"
    case .syncing:
      return "Syncing"
    case .error:
      return "Connection error"
    case .disconnected:
      return "Disconnected"
    }
  }

  private var statusColor: Color {
    switch syncService.connectionState {
    case .connected:
      return .green
    case .connecting, .syncing:
      return .orange
    case .error:
      return .red
    case .disconnected:
      return .gray
    }
  }
}

struct ConnectionSettingsView: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService
  @State private var host = "127.0.0.1"
  @State private var port = "8787"
  @State private var pairingCode = ""

  var body: some View {
    NavigationStack {
      Form {
        Section("Host connection") {
          TextField("Host", text: $host)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          TextField("Port", text: $port)
            .keyboardType(.numberPad)
          TextField("Pairing code", text: $pairingCode)
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
        }

        if let error = syncService.lastError {
          Section("Status") {
            Text(error)
              .foregroundStyle(.red)
          }
        }

        Section {
          Button("Pair and connect") {
            Task {
              await syncService.pairAndConnect(host: host, port: Int(port) ?? 8787, code: pairingCode)
              if syncService.connectionState == .connected {
                dismiss()
              }
            }
          }
          .buttonStyle(.borderedProminent)

          Button("Reconnect using saved pairing") {
            Task {
              await syncService.reconnectIfPossible()
              if syncService.connectionState == .connected {
                dismiss()
              }
            }
          }

          Button("Disconnect", role: .destructive) {
            syncService.disconnect()
          }
        }
      }
      .onAppear {
        guard let draft = syncService.loadDraft() else { return }
        host = draft.host
        port = String(draft.port)
      }
      .navigationTitle("Connection")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") {
            dismiss()
          }
        }
      }
    }
  }
}
