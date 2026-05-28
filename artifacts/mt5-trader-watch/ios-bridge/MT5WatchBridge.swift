// iOS-side WatchConnectivity bridge for the phone app.
//
// Place this file inside the iOS target (NOT the watchOS target) in Xcode
// after running `npx expo prebuild --platform ios`.
//
// Expo native module registration:
//   1. Add a bridging header (Xcode will prompt) if not already present.
//   2. The @objc class + methods below are auto-bridged to React Native via
//      Expo's RCTBridgeModule. No manual export macro needed because this is
//      a thin one-method module — Expo's autolinking picks it up.
//   3. From JS:
//        import { NativeModules } from "react-native";
//        NativeModules.MT5WatchBridge.publishSession({
//          token, apiBase, accountId, region,
//        });
//      Call this in the phone app's AuthContext whenever sign-in succeeds,
//      whenever the token is refreshed, and whenever the user connects/switches
//      MT5 accounts.
//
// What this does: pushes { token, apiBase, accountId, region } to the paired
// Apple Watch via WatchConnectivity's applicationContext (persistent — survives
// watch app relaunches and phone-asleep states).

import Foundation
import WatchConnectivity
import React

@objc(MT5WatchBridge)
class MT5WatchBridge: NSObject, RCTBridgeModule, WCSessionDelegate {
    static func moduleName() -> String! { "MT5WatchBridge" }
    static func requiresMainQueueSetup() -> Bool { false }

    override init() {
        super.init()
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    @objc(publishSession:resolver:rejecter:)
    func publishSession(_ payload: [String: Any],
                        resolver resolve: RCTPromiseResolveBlock,
                        rejecter reject: RCTPromiseRejectBlock) {
        guard WCSession.isSupported() else {
            reject("no_wc", "WatchConnectivity not supported on this device", nil)
            return
        }
        let session = WCSession.default
        guard session.activationState == .activated else {
            reject("not_active", "WCSession not activated yet", nil)
            return
        }
        do {
            // Drop nil values — applicationContext doesn't like NSNull.
            var clean: [String: Any] = [:]
            for (k, v) in payload where !(v is NSNull) { clean[k] = v }
            try session.updateApplicationContext(clean)
            resolve(true)
        } catch {
            reject("wc_error", error.localizedDescription, error)
        }
    }

    // MARK: - WCSessionDelegate stubs (required)

    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        if let error = error {
            NSLog("[MT5WatchBridge] WC activation error: \(error.localizedDescription)")
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) { /* iOS-only */ }
    func sessionDidDeactivate(_ session: WCSession) {
        // Re-activate so the bridge can pair with a different watch later.
        WCSession.default.activate()
    }
}
