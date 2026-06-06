import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";

// Route taps on a TP-alert push back to the Positions screen, where the
// matching ZoneCard lives. The zoneId travels through `data` so we can also
// surface it as a query param for the screen to highlight if desired.
export function useNotificationDeepLink(): void {
  const router = useRouter();

  useEffect(() => {
    const go = (data: unknown) => {
      const zoneId = (data as { zoneId?: unknown } | null)?.zoneId;
      try {
        router.push(typeof zoneId === "string" && zoneId
          ? { pathname: "/positions", params: { zoneId, highlightZone: zoneId } }
          : "/positions");
      } catch {
        // Router may not be mounted yet on cold-start; the response listener
        // will refire after the next user interaction.
      }
    };

    // Push notification APIs are native-only; skip entirely on web.
    if (Platform.OS === "web") return;

    // Cold-start: app was opened by tapping a notification while killed.
    Notifications.getLastNotificationResponseAsync().then((resp) => {
      if (resp) go(resp.notification.request.content.data);
    });

    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      go(resp.notification.request.content.data);
    });
    return () => sub.remove();
  }, [router]);
}
