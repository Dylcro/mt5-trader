import SwiftUI
import WatchKit

struct TradeView: View {
    @EnvironmentObject var session: SessionStore
    @State private var busy: BusyAction? = nil
    @State private var lastResult: ResultBanner? = nil

    enum BusyAction { case buy, sell, riskFree }

    struct ResultBanner: Identifiable {
        let id = UUID()
        let text: String
        let isError: Bool
    }

    var body: some View {
        VStack(spacing: 6) {
            if let r = lastResult {
                Text(r.text)
                    .font(.footnote)
                    .foregroundColor(r.isError ? .red : .green)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }

            if !session.isReady {
                Text("Sign in on phone")
                    .font(.footnote)
                    .foregroundColor(.gray)
                    .padding(.top, 8)
            } else {
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
                        .font(.system(size: 18, weight: .heavy))
                        .foregroundColor(.black)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44)
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
}
