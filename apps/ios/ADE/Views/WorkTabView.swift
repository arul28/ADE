import SwiftUI

struct WorkTabView: View {
  var isActive = true

  var body: some View {
    WorkRootScreen(isTabActive: isActive)
  }
}
