import { Feather } from "@expo/vector-icons";
import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Colors from "@/constants/colors";
import { useBiometric } from "@/hooks/useBiometric";

const C = Colors.dark;

export default function BiometricLockScreen() {
  const insets = useSafeAreaInsets();
  const { locked, unlock, loading } = useBiometric();
  const [unlocking, setUnlocking] = React.useState(false);

  if (!locked || loading) return null;

  const handleUnlock = async () => {
    setUnlocking(true);
    try {
      await unlock();
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <View style={[styles.overlay, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.iconCircle}>
        <Feather name="lock" size={32} color={C.gold} />
      </View>
      <Text style={styles.title}>App locked</Text>
      <Text style={styles.subtitle}>Authenticate to continue trading</Text>
      <Pressable
        style={({ pressed }) => [styles.btn, pressed && { opacity: 0.85 }]}
        onPress={() => void handleUnlock()}
        disabled={unlocking}
      >
        {unlocking ? (
          <ActivityIndicator color="#000" />
        ) : (
          <>
            <Feather name="unlock" size={18} color="#000" />
            <Text style={styles.btnText}>Unlock</Text>
          </>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: C.background,
    zIndex: 9999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "rgba(201,168,76,0.12)",
    borderWidth: 1,
    borderColor: "rgba(201,168,76,0.3)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  title: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: C.text,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
    marginBottom: 28,
    textAlign: "center",
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.gold,
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
    minWidth: 160,
    justifyContent: "center",
  },
  btnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#000",
  },
});
