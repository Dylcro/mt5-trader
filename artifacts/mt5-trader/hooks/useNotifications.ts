import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";

import { useNotificationSettings } from "@/hooks/useNotificationSettings";

export function useNotifications() {
  const { prefs, loading, permissionStatus, updatePrefs } = useNotificationSettings();
  const lastNotificationId = useRef<string | null>(null);

  useEffect(() => {
    const received = Notifications.addNotificationReceivedListener((n) => {
      lastNotificationId.current = n.request.identifier;
    });
    const response = Notifications.addNotificationResponseReceivedListener(() => {
      // Deep linking handled by useNotificationDeepLink at root layout.
    });
    return () => {
      received.remove();
      response.remove();
    };
  }, []);

  return {
    prefs,
    loading,
    permissionStatus,
    updatePrefs,
    lastNotificationId: lastNotificationId.current,
    nearAlertsEnabled: prefs.nearEnabled,
    hitAlertsEnabled: prefs.hitEnabled,
    thresholdPips: prefs.thresholdPips,
  };
}
