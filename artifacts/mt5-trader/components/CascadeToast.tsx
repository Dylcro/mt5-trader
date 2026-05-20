import { Feather } from "@expo/vector-icons";
import React, { useEffect, useRef } from "react";
import { Animated, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import Colors from "@/constants/colors";
import { useTrading } from "@/context/TradingContext";

const C = Colors.dark;
const AUTO_DISMISS_MS = 5000;

export function CascadeToast() {
  const { cascadeNotification, clearCascadeNotification } = useTrading();
  const translateY = useRef(new Animated.Value(-100)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!cascadeNotification) return;

    if (timerRef.current) clearTimeout(timerRef.current);

    Animated.parallel([
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, tension: 80, friction: 10 }),
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start();

    timerRef.current = setTimeout(() => {
      dismiss();
    }, AUTO_DISMISS_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cascadeNotification]);

  const dismiss = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    Animated.parallel([
      Animated.timing(translateY, { toValue: -100, duration: 250, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => clearCascadeNotification());
  };

  if (!cascadeNotification) return null;

  const count = cascadeNotification.count;
  const label = count === 1 ? "1 limit order" : `${count} limit orders`;

  return (
    <Animated.View
      style={[
        styles.container,
        { transform: [{ translateY }], opacity },
        Platform.OS === "web" && styles.containerWeb,
      ]}
      pointerEvents="box-none"
    >
      <View style={styles.toast}>
        <View style={styles.iconWrap}>
          <Feather name="zap" size={16} color={C.gold} />
        </View>
        <View style={styles.textWrap}>
          <Text style={styles.title}>Auto-cascade triggered</Text>
          <Text style={styles.body}>Placed {label} for your MT5 trade</Text>
        </View>
        <Pressable onPress={dismiss} hitSlop={12} style={styles.closeBtn}>
          <Feather name="x" size={16} color={C.textSecondary} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    alignItems: "center",
    paddingTop: 54,
    paddingHorizontal: 16,
    pointerEvents: "box-none",
  } as object,
  containerWeb: {
    paddingTop: 80,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(201,168,76,0.45)",
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
    maxWidth: 420,
    width: "100%",
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: "rgba(201,168,76,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  textWrap: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  body: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: C.textSecondary,
  },
  closeBtn: {
    padding: 4,
  },
});
