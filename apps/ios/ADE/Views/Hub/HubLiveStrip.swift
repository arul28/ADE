import SwiftUI

/// "Live now" — a horizontal strip of the agents currently working, across
/// every machine on the account rather than only the paired one.
///
/// It reads the account snapshot through `ActivityDrawerModel`, so a session on
/// the Studio shows up on the phone's home screen without opening anything.
/// Hidden entirely when nothing is live: an empty strip is a permanent reminder
/// that nothing is happening, which is the opposite of the point.
struct HubLiveStrip: View {
    @EnvironmentObject private var drawer: ActivityDrawerModel

    private var rows: [ActivityRowPresentation] { drawer.liveNow }

    var body: some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 7) {
                    Text("Live now")
                        .font(.system(.caption, design: .rounded).weight(.semibold))
                        .foregroundStyle(ADEColor.textSecondary)
                    Text("\(rows.count)")
                        .font(.system(.caption2, design: .rounded).weight(.semibold).monospacedDigit())
                        .foregroundStyle(ADEColor.textMuted)
                        .contentTransition(.numericText())
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 2)

                ScrollView(.horizontal) {
                    HStack(spacing: 10) {
                        ForEach(rows) { row in
                            ActivityRow(
                                row: row,
                                density: .compact,
                                dimmed: !row.machineOnline
                            ) {
                                open(row)
                            }
                        }
                    }
                    .padding(.horizontal, 2)
                    .padding(.vertical, 1)
                }
                .scrollIndicators(.hidden)
            }
            .accessibilityLabel("Live now, \(rows.count) sessions")
        }
    }

    private func open(_ row: ActivityRowPresentation) {
        guard let url = row.deepLink else { return }
        drawer.markSeen(row.id)
        DeepLinkRouter.shared.handle(url)
    }
}
