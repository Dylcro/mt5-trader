import Foundation
import Security
import WatchConnectivity

/// Holds the bearer token + API base URL + MT5 account id received from the
/// paired iPhone over WatchConnectivity. The phone-side bridge
/// (`MT5WatchBridge.swift`) is responsible for pushing these whenever they
/// change (sign-in, account switch, token refresh).
///
/// Token: stored in the watch **Keychain** (Security framework). The bearer
/// token grants full account control, so we never put it in UserDefaults.
/// Non-sensitive config (apiBase, accountId, region) lives in UserDefaults so
/// the watch survives relaunches without waiting for the phone to wake up.
final class SessionStore: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = SessionStore()

    @Published var token: String? = nil
    @Published var apiBase: String? = UserDefaults.standard.string(forKey: "mt5.apiBase")
    @Published var accountId: String? = UserDefaults.standard.string(forKey: "mt5.accountId")
    @Published var region: String = UserDefaults.standard.string(forKey: "mt5.region") ?? "london"

    private let keychainService = "com.xauusdtrader.watch"
    private let keychainAccount = "bearerToken"

    private override init() {
        super.init()
        self.token = readTokenFromKeychain()
    }

    func activate() {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        s.delegate = self
        s.activate()
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
            writeTokenToKeychain(t)
        } else if ctx.keys.contains("token") {
            // Explicit null = sign-out from phone
            self.token = nil
            deleteTokenFromKeychain()
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

    // MARK: - Keychain

    private func keychainQuery() -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
    }

    private func writeTokenToKeychain(_ token: String) {
        guard let data = token.data(using: .utf8) else { return }
        var q = keychainQuery()
        SecItemDelete(q as CFDictionary)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(q as CFDictionary, nil)
        if status != errSecSuccess {
            NSLog("[SessionStore] keychain write failed: \(status)")
        }
    }

    private func readTokenFromKeychain() -> String? {
        var q = keychainQuery()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func deleteTokenFromKeychain() {
        SecItemDelete(keychainQuery() as CFDictionary)
    }
}
