import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";

export const ONBOARDING_KEY = "onboarding_complete_v2";

export function useOnboardingGate() {
  const [show, setShow] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const done = await AsyncStorage.getItem(ONBOARDING_KEY);
        setShow(done !== "true");
      } catch {
        setShow(true);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const complete = useCallback(async () => {
    try {
      await AsyncStorage.setItem(ONBOARDING_KEY, "true");
    } catch {
      /* ignore */
    }
    setShow(false);
  }, []);

  return { show, ready, complete };
}
