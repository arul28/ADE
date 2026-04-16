import SwiftUI

struct PrStackSheet: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let groupId: String
  let groupName: String?
  @State private var members: [PrGroupMemberSummary] = []

  var body: some View {
    NavigationStack {
      List {
        if members.isEmpty {
          ADEEmptyStateView(
            symbol: "list.number",
            title: "No stack members",
            message: "The host did not sync any PR chain members for this workflow yet."
          )
          .prListRow()
        } else {
          ForEach(members) { member in
            VStack(alignment: .leading, spacing: 8) {
              HStack(alignment: .top) {
                ADEStatusPill(text: "#\(member.position + 1)", tint: ADEColor.accent)
                Spacer(minLength: 8)
                ADEStatusPill(text: member.state.uppercased(), tint: prStateTint(member.state))
              }
              Text(member.title)
                .font(.headline)
                .foregroundStyle(ADEColor.textPrimary)
              Text("#\(member.githubPrNumber) · \(member.headBranch) → \(member.baseBranch)")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(ADEColor.textSecondary)
              Text(member.laneName)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
            .adeGlassCard(cornerRadius: 18)
            .prListRow()
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle(groupName ?? "PR stack")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") {
            dismiss()
          }
        }
      }
      .task {
        members = (try? await syncService.fetchPullRequestGroupMembers(groupId: groupId)) ?? []
      }
    }
  }
}
