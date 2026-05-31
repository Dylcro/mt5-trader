import { Feather } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import Colors from "@/constants/colors";
import { useSessionExpiry } from "@/hooks/useSessionExpiry";

const C = Colors.dark;

export default function SessionWarningBanner() {
  const { showWarning, minutesRemaining, dismissWarning } = useSessionExpiry();

  if (!showWarning || minutesRemaining == null) return null;

  return (
    <View style={styles.wrap}>
      <Feather name="clock" size={16} color={C.gold} />
      <Text style={styles.text}>
        Session expires in {minutesRemaining} min — save your work and sign in again if needed.
      </Text>
      <Pressable onPress={dismissWarning} hitSlop={8}>
        <Feather name="x" size={18} color={C.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(201,168,76,0.15)",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(201,168,76,0.35)",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  text: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: C.text,
    lineHeight: 18,
  },
});
