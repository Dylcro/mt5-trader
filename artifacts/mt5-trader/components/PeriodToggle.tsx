import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import Colors from "@/constants/colors";
import type { Period } from "@/lib/zoneStats";

const C = Colors.dark;

export default function PeriodToggle({
  value,
  onChange,
}: {
  value: Period;
  onChange: (p: Period) => void;
}) {
  return (
    <View style={styles.wrap}>
      {(["today", "week"] as const).map((p) => {
        const active = value === p;
        return (
          <Pressable
            key={p}
            onPress={() => onChange(p)}
            style={[styles.btn, active && styles.btnActive]}
          >
            <Text style={[styles.text, active && styles.textActive]}>
              {p === "today" ? "Today" : "Week"}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    backgroundColor: C.surface,
    borderRadius: 8,
    padding: 2,
    borderWidth: 1,
    borderColor: C.border,
  },
  btn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  btnActive: {
    backgroundColor: C.card,
    shadowColor: C.shadow,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 1,
    shadowRadius: 2,
    elevation: 1,
  },
  text: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: C.textMuted,
  },
  textActive: {
    color: C.text,
  },
});
