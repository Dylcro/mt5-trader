import SwiftUI

@main
struct MT5WatchApp: App {
    @StateObject private var session = SessionStore.shared

    var body: some Scene {
        WindowGroup {
            TradeView()
                .environmentObject(session)
                .onAppear { session.activate() }
        }
    }
}
