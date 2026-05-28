import Foundation

/// Thin client for the three watch operations: BUY market, SELL market, RISK FREE.
/// All calls are bearer-token authenticated against the same Express API the
/// phone app uses.
struct APIClient {
    let apiBase: String
    let token: String
    let accountId: String
    let region: String

    private let symbol = "XAUUSD"
    private let pip = 0.10

    struct TradeDefaults: Decodable {
        let lotSize: Double
        let tp1Pips: Double
        let tp2Pips: Double
        let tp3Pips: Double
        let tp4Pips: Double
        let slPips: Double
    }

    struct Price: Decodable {
        let bid: Double
        let ask: Double
    }

    struct LatestZone: Decodable {
        let zoneId: String
        let direction: String
        let anchorPrice: Double
    }

    enum APIError: Error, LocalizedError {
        case http(Int, String)
        case noOpenZone
        case noPrice
        var errorDescription: String? {
            switch self {
            case .http(let code, let msg): return "HTTP \(code): \(msg)"
            case .noOpenZone: return "No open zone"
            case .noPrice: return "No live price"
            }
        }
    }

    // MARK: - GETs

    func fetchDefaults() async throws -> TradeDefaults {
        try await getJSON("/mt5/user/trade-defaults")
    }

    func fetchPrice() async throws -> Price {
        try await getJSON("/mt5/account/\(accountId)/price?region=\(region)")
    }

    func fetchLatestOpenZone() async throws -> LatestZone {
        do {
            return try await getJSON("/mt5/account/\(accountId)/zones/latest-open")
        } catch APIError.http(let code, _) where code == 404 {
            throw APIError.noOpenZone
        }
    }

    // MARK: - The three watch actions

    /// Fires a single market order at the current bid/ask with SL + TP1.
    /// The server-side zone engine handles partial closes at TP2-4 automatically
    /// when the position is tagged with the right comment.
    func placeMarketOrder(direction: String) async throws {
        let defaults = try await fetchDefaults()
        let price = try await fetchPrice()
        let entry = direction == "buy" ? price.ask : price.bid
        let sign = direction == "buy" ? 1.0 : -1.0

        let sl = (entry - sign * defaults.slPips * pip).rounded(toDecimal: 2)
        // We attach TP1 as the broker-side TP. The server handles TP2-4 via the
        // zone monitor (which also creates the zone when it sees this market
        // entry come through).
        let tp1 = (entry + sign * defaults.tp1Pips * pip).rounded(toDecimal: 2)
        let tp2 = (entry + sign * defaults.tp2Pips * pip).rounded(toDecimal: 2)
        let tp3 = (entry + sign * defaults.tp3Pips * pip).rounded(toDecimal: 2)
        let tp4: Double? = defaults.tp4Pips > 0
            ? (entry + sign * defaults.tp4Pips * pip).rounded(toDecimal: 2)
            : nil

        // Comment MUST start with "Cascade" — the API server uses that prefix to
        // detect a market leg that should create a zone (which in turn powers the
        // 25%-at-each-TP staged exit). "Watch BUY/SELL" would be treated as a
        // plain trade, ignoring TP2/TP3/TP4. Format mirrors the phone's
        // "Cascade 1/N" pattern; 1/1 because the watch fires no limit ladder.
        var body: [String: Any] = [
            "actionType": direction == "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
            "symbol": symbol,
            "volume": defaults.lotSize,
            "comment": "Cascade 1/1 (watch)",
            "stopLoss": sl,
            "takeProfit": tp1,
            "tp1Price": tp1,
            "tp2Price": tp2,
            "tp3Price": tp3,
            "anchorPrice": entry,
        ]
        if let tp4 = tp4 { body["tp4Price"] = tp4 }

        try await postJSONIgnoreResponse(
            "/mt5/account/\(accountId)/trade?region=\(region)",
            body: body
        )
    }

    /// Risk-free the most-recently-opened OPEN zone.
    func riskFreeLatestZone() async throws {
        let zone = try await fetchLatestOpenZone()
        try await postJSONIgnoreResponse(
            "/mt5/account/\(accountId)/zones/\(zone.zoneId)/risk-free",
            body: [:]
        )
    }

    // MARK: - Plumbing

    private func getJSON<T: Decodable>(_ path: String) async throws -> T {
        var req = URLRequest(url: URL(string: apiBase + path)!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 15
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError.http(0, "no response") }
        if http.statusCode >= 400 {
            let msg = String(data: data, encoding: .utf8) ?? ""
            throw APIError.http(http.statusCode, msg)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func postJSONIgnoreResponse(_ path: String, body: [String: Any]) async throws {
        var req = URLRequest(url: URL(string: apiBase + path)!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 20
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError.http(0, "no response") }
        if http.statusCode >= 400 {
            let msg = String(data: data, encoding: .utf8) ?? ""
            throw APIError.http(http.statusCode, msg)
        }
    }
}

private extension Double {
    func rounded(toDecimal places: Int) -> Double {
        let p = pow(10.0, Double(places))
        return (self * p).rounded() / p
    }
}
