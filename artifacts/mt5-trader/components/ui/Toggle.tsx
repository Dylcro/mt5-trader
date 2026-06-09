import React, { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";

interface ToggleProps {
  value: boolean;
  onValueChange: (v: boolean) => void;
  color?: string;
  disabled?: boolean;
}

export default function Toggle({ value, onValueChange, color = "#C9892E", disabled }: ToggleProps) {
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(anim, {
      toValue: value ? 1 : 0,
      useNativeDriver: false,
      friction: 8,
      tension: 120,
    }).start();
  }, [value, anim]);

  const trackBg = anim.interpolate({
    inputRange: [0, 1],
    outputRange: ["#D1D5DB", color],
  });
  const thumbLeft = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [3, 21],
  });

  return (
    <Pressable onPress={() => !disabled && onValueChange(!value)} disabled={disabled} hitSlop={6}>
      <Animated.View style={[styles.track, { backgroundColor: trackBg }, disabled && { opacity: 0.5 }]}>
        <Animated.View style={[styles.thumb, { left: thumbLeft }]} />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: 44,
    height: 26,
    borderRadius: 13,
    justifyContent: "center",
  },
  thumb: {
    position: "absolute",
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
});
