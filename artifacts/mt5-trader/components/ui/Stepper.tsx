import { Feather } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import Colors from "@/constants/colors";

const C = Colors.dark;

interface StepperProps {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  display?: string;
  valueColor?: string;
  disabled?: boolean;
}

export default function Stepper({
  value,
  onChange,
  step = 1,
  min = -Infinity,
  max = Infinity,
  display,
  valueColor,
  disabled,
}: StepperProps) {
  const dec = () => {
    const next = Math.round((value - step) / step) * step;
    if (next >= min) onChange(next);
  };
  const inc = () => {
    const next = Math.round((value + step) / step) * step;
    if (next <= max) onChange(next);
  };

  return (
    <View style={styles.row}>
      <Pressable
        style={({ pressed }) => [styles.btn, pressed && { opacity: 0.6 }, disabled && { opacity: 0.4 }]}
        onPress={dec}
        disabled={disabled || value - step < min}
        hitSlop={6}
      >
        <Feather name="minus" size={14} color={C.text} />
      </Pressable>
      <Text style={[styles.value, valueColor ? { color: valueColor } : null]}>
        {display ?? String(value)}
      </Text>
      <Pressable
        style={({ pressed }) => [styles.btn, pressed && { opacity: 0.6 }, disabled && { opacity: 0.4 }]}
        onPress={inc}
        disabled={disabled || value + step > max}
        hitSlop={6}
      >
        <Feather name="plus" size={14} color={C.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.specBorder,
    overflow: "hidden",
  },
  btn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  value: {
    minWidth: 56,
    textAlign: "center",
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: C.text,
    paddingHorizontal: 4,
  },
});
