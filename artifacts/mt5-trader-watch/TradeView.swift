import SwiftUI
import WatchKit

/// Single-screen watch dashboard:
///   - Live bid/ask (top)
///   - Total P&L across all open positions
///   - Compact status line for the most-recent OPEN zone (direction, anchor,
///     which TPs have hit)
///   - Three big buttons: BUY / SELL / RISK FREE
///
/// Polls the API every 3 seconds while the view is visible; pauses when the
/// watch screen sleeps (`.scenePhase` becomes `.background`).
struct TradeView: View {
    @EnvironmentObject var session: SessionStore
    @Environment(\.scenePhase) private var scenePhase

    @State private var bid: Double? = nil
    @State private var ask: Double? = nil
    @State private var totalPnL: Double? = nil
    @State private var latestZone: APIClient.Zone? = nil
    @State private var pollTask: Task<Void, Never>? = nil

    @State private var busy: BusyAction? = nil
    @State private var lastResult: ResultBanner? = nil

    enum BusyAction { case buy, sell, riskFree }

    struct ResultBanner: Identifiable {
        let id = UUID()
        let text: String
        let isError: Bool
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 6) {
                if !session.isReady {
                    Text("Sign in on phone")
                        .font(.footnote)
                        .foregroundColor(.gray)
                        .padding(.top, 12)
                } else {
                    priceRow
                    pnlRow
                    zoneRow
                    if let r = lastResult {
                        Text(r.text)
                            .font(.system(size: 11))
                            .foregroundColor(r.isError ? .red : .green)
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                            .padding(.top, 2)
                    }
                    bigButton(title: "BUY", color: .green, action: .buy) {
                        await runTrade(direction: "buy")
                    }
                    bigButton(title: "SELL", color: .red, action: .sell) {
                        await runTrade(direction: "sell")
                    }
                    bigButton(title: "RISK FREE", color: .yellow, action: .riskFree) {
                        await runRiskFree()
                    }
                }
            }
            .padding(.horizontal, 4)
        }
        .onAppear { startPolling() }
        .onDisappear { stopPolling() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { startPolling() } else { stopPolling() }
        }
        .onChange(of: session.isReady) { _, ready in
            if ready { startPolling() }
        }
    }

    // MARK: - Live data rows

    private var priceRow: some View {
        HStack {
            Text("XAUUSD")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.gray)
            Spacer()
            if let bid = bid, let ask = ask {
                Text(String(format: "%.2f", bid))
                    .font(.system(size: 13, weight: .bold, design: .monospaced))
                    .foregroundColor(.red)
                Text("/")
                    .font(.system(size: 11))
                    .foregroundColor(.gray)
                Text(String(format: "%.2f", ask))
                    .font(.system(size: 13, weight: .bold, design: .monospaced))
                    .foregroundColor(.green)
            } else {
                Text("—")
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundColor(.gray)
            }
        }
    }

    private var pnlRow: some View {
        HStack {
            Text("P&L")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.gray)
            Spacer()
            if let p = totalPnL {
                Text(String(format: "%@$%.2f", p < 0 ? "-" : "", abs(p)))
                    .font(.system(size: 14, weight: .bold, design: .monospaced))
                    .foregroundColor(p < 0 ? .red : (p > 0 ? .green : .white))
            } else {
                Text("—")
                    .font(.system(size: 14, design: .monospaced))
                    .foregroundColor(.gray)
            }
        }
    }

    private var zoneRow: some View {
        Group {
            if let z = latestZone {
                let tps = tpFlagsText(z)
                HStack(spacing: 4) {
                    Text(z.direction.uppercased())
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(z.direction == "buy" ? .green : .red)
                    Text("@")
                        .font(.system(size: 10))
                        .foregroundColor(.gray)
                    Text(String(format: "%.2f", z.anchorPrice))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.white)
                    Spacer()
                    Text(tps)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.gray)
                }
            } else {
                HStack {
                    Text("No open zone")
                        .font(.system(size: 10))
                        .foregroundColor(.gray)
                    Spacer()
                }
            }
        }
    }

    private func tpFlagsText(_ z: APIClient.Zone) -> String {
        // Compact: ✓ for hit, · for not, e.g. "TP ✓···"
        let marks = [z.tp1Hit, z.tp2Hit, z.tp3Hit, z.tp4Hit].map { $0 ? "✓" : "·" }.joined()
        return "TP \(marks)"
    }

    // MARK: - Buttons

    @ViewBuilder
    private func bigButton(title: String, color: Color, action: BusyAction, perform: @escaping () async -> Void) -> some View {
        Button {
            Task { await perform() }
        } label: {
            HStack {
                if busy == action {
                    ProgressView().tint(.black)
                } else {
                    Text(title)
                        .font(.system(size: 16, weight: .heavy))
                        .foregroundColor(.black)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 38)
            .background(color.opacity(busy != nil && busy != action ? 0.4 : 1.0))
            .cornerRadius(10)
        }
        .buttonStyle(.plain)
        .disabled(busy != nil)
    }

    private func runTrade(direction: String) async {
        guard let client = makeClient() else { return }
        busy = direction == "buy" ? .buy : .sell
        WKInterfaceDevice.current().play(.click)
        do {
            try await client.placeMarketOrder(direction: direction)
            WKInterfaceDevice.current().play(.success)
            lastResult = ResultBanner(text: "\(direction.uppercased()) placed", isError: false)
            await refreshOnce()
        } catch {
            WKInterfaceDevice.current().play(.failure)
            lastResult = ResultBanner(text: error.localizedDescription, isError: true)
        }
        busy = nil
    }

    private func runRiskFree() async {
        guard let client = makeClient() else { return }
        busy = .riskFree
        WKInterfaceDevice.current().play(.click)
        do {
            try await client.riskFreeLatestZone()
            WKInterfaceDevice.current().play(.success)
            lastResult = ResultBanner(text: "Risk-free applied", isError: false)
            await refreshOnce()
        } catch APIClient.APIError.noOpenZone {
            WKInterfaceDevice.current().play(.failure)
            lastResult = ResultBanner(text: "No open zone", isError: true)
        } catch {
            WKInterfaceDevice.current().play(.failure)
            lastResult = ResultBanner(text: error.localizedDescription, isError: true)
        }
        busy = nil
    }

    private func makeClient() -> APIClient? {
        guard let t = session.token, let b = session.apiBase, let a = session.accountId else { return nil }
        return APIClient(apiBase: b, token: t, accountId: a, region: session.region)
    }

    // MARK: - Polling

    private func startPolling() {
        stopPolling()
        guard session.isReady else { return }
        pollTask = Task {
            while !Task.isCancelled {
                await refreshOnce()
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func refreshOnce() async {
        guard let client = makeClient() else { return }
        async let price = try? client.fetchPrice()
        async let pnl = try? client.fetchTotalPnL()
        async let zone = try? client.fetchLatestOpenZone()
        let p = await price
        let l = await pnl
        let z = await zone
        await MainActor.run {
            if let p = p { self.bid = p.bid; self.ask = p.ask }
            if let l = l { self.totalPnL = l }
            self.latestZone = z ?? nil
        }
    }
}
