import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import Colors from "@/constants/colors";
import { DISPLAY_CURRENCY_OPTIONS, type DisplayCurrency } from "@/lib/displayCurrency";

const C = Colors.dark;

export default function CurrencyPicker({
  value,
  onChange,
}: {
  value: DisplayCurrency;
  onChange: (c: DisplayCurrency) => void;
}) {
  return (
    <View style={styles.wrap}>
      {DISPLAY_CURRENCY_OPTIONS.map((opt) => {
        const active = value === opt.code;
        return (
          <Pressable
            key={opt.code}
            onPress={() => onChange(opt.code)}
            style={[styles.btn, active && styles.btnActive]}
          >
            <Text style={[styles.text, active && styles.textActive]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    backgroundColor: C.surface,
    borderRadius: 8,
    padding: 4,
    borderWidth: 1,
    borderColor: C.border,
  },
  btn: {
    flex: 1,
    minWidth: 88,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: "center",
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
