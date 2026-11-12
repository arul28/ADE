import SwiftUI

/// The Hub on the phone, the Duo's outer display and every other iPhone: the
/// header row, the roster filter row, the project list, and the composer under
/// it as the screen's footer (the list ends above it), at the screen's bottom
/// the way a bottom bar sits.
struct HubPhoneLayout<Title: View, FilterBar: View, Roster: View, Composer: View>: View {
  @Binding var composerExpanded: Bool
  let actions: HubToolbarActions
  @ViewBuilder var title: () -> Title
  @ViewBuilder var filterBar: () -> FilterBar
  @ViewBuilder var roster: () -> Roster
  @ViewBuilder var composer: () -> Composer
  /// Where the status bar leaves an empty band beside the clock
  /// (`hubStatusBandReading`): the band's width and height. The header
  /// moves up into it and everything under it gains the row's height.
  @State private var statusBand: CGSize?

  var body: some View {
    VStack(spacing: 0) {
      header
      filterBar()
      roster()
        .frame(maxHeight: .infinity)
        // The list ends at the composer's top, never behind it.
        .clipped()
        // While the composer is expanded, a dim scrim covers the list: it
        // swallows taps and drags (no accidental row opens), and any touch on
        // it collapses the composer.
        .overlay {
          if composerExpanded {
            Color.black.opacity(0.38)
              .ignoresSafeArea()
              .onTapGesture { collapse() }
              .gesture(
                DragGesture(minimumDistance: 12).onEnded { value in
                  if value.translation.height > 24 { collapse() }
                }
              )
              .transition(.opacity)
          }
        }
      HubComposerClearsCorner(content: composer)
    }
    .hubComposerAtScreenBottom()
    .onGeometryChange(for: HubStatusBandGeometry.self) { proxy in
      let reading = hubStatusBandReading(proxy)
      return HubStatusBandGeometry(
        band: reading.width.map { CGSize(width: $0, height: proxy.safeAreaInsets.top) },
        detail: reading.detail
      )
    } action: { geometry in
      if geometry.band != statusBand { statusBand = geometry.band }
      HubLayoutDiagnostics.shared.hubHeader = geometry.detail
    }
    .navigationBarTitleDisplayMode(.inline)
    // The header is a row of its own (under the status bar, the full width),
    // the same row every other form of the Hub shows.
    .toolbar(.hidden, for: .navigationBar)
  }

  @ViewBuilder
  private var header: some View {
    if let statusBand {
      // In the band beside the clock, level with it, ending short of it.
      HubHeaderRow(actions: actions, title: title)
        .environment(\.hubHeaderInline, true)
        .padding(.leading, 16)
        .frame(width: max(0, statusBand.width - 8), alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: statusBand.height, alignment: .center)
        .padding(.top, 6)
        .padding(.top, -statusBand.height)
        .padding(.bottom, 8)
    } else {
      HubHeaderRow(actions: actions, title: title)
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
        .hubHeaderClearsStatusBar()
    }
  }

  private func collapse() {
    withAnimation(hubComposerSpring) { composerExpanded = false }
  }
}

/// The Hub header's geometry reading: the band beside the clock (nil = a
/// row of its own) and the facts behind it, for Settings › Advanced.
private struct HubStatusBandGeometry: Equatable {
  var band: CGSize?
  var detail: String
}
