import Foundation
import WatchConnectivity

/// Holds the bearer token + API base URL + MT5 account id received from the
/// paired iPhone over WatchConnectivity. The phone-side bridge
/// (`MT5WatchBridge.swift`) is responsible for pushing these whenever they
/// change (sign-in, account switch, token refresh).
///
/// On disk: cached in UserDefaults so the watch survives relaunches without
/// having to wait for the phone to wake up.
final class SessionStore: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = SessionStore()

    @Published var token: String? = UserDefaults.standard.string(forKey: "mt5.token")
    @Published var apiBase: String? = UserDefaults.standard.string(forKey: "mt5.apiBase")
    @Published var accountId: String? = UserDefaults.standard.string(forKey: "mt5.accountId")
    @Published var region: String = UserDefaults.standard.string(forKey: "mt5.region") ?? "london"

    private override init() { super.init() }

    func activate() {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        s.delegate = self
        s.activate()
        // Pull whatever the phone last published in case the app was force-quit
        // before the watch received it.
        applyContext(s.receivedApplicationContext)
    }

    var isReady: Bool {
        guard let t = token, !t.isEmpty,
              let b = apiBase, !b.isEmpty,
              let a = accountId, !a.isEmpty else { return false }
        return true
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        if let error = error {
            NSLog("[SessionStore] WC activation error: \(error.localizedDescription)")
        }
        applyContext(session.receivedApplicationContext)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {
        DispatchQueue.main.async { self.applyContext(applicationContext) }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
        DispatchQueue.main.async { self.applyContext(message) }
    }

    private func applyContext(_ ctx: [String : Any]) {
        if let t = ctx["token"] as? String, !t.isEmpty {
            self.token = t
            UserDefaults.standard.set(t, forKey: "mt5.token")
        }
        if let b = ctx["apiBase"] as? String, !b.isEmpty {
            self.apiBase = b
            UserDefaults.standard.set(b, forKey: "mt5.apiBase")
        }
        if let a = ctx["accountId"] as? String, !a.isEmpty {
            self.accountId = a
            UserDefaults.standard.set(a, forKey: "mt5.accountId")
        }
        if let r = ctx["region"] as? String, !r.isEmpty {
            self.region = r
            UserDefaults.standard.set(r, forKey: "mt5.region")
        }
    }
}
