import { Feather } from "@expo/vector-icons";
import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Colors from "@/constants/colors";
import { useAIAssistant } from "@/hooks/useAIAssistant";

const C = Colors.dark;

export default function AIAssistantPanel() {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const { messages, sending, sendMessage, clearChat } = useAIAssistant();
  const scrollRef = useRef<ScrollView>(null);

  const handleSend = () => {
    const text = input;
    setInput("");
    void sendMessage(text).then(() => {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    });
  };

  return (
    <>
      <Pressable
        style={[styles.fab, { bottom: 88 + insets.bottom }]}
        onPress={() => setOpen(true)}
        accessibilityLabel="Open trading assistant"
      >
        <Feather name="message-circle" size={24} color="#000" />
      </Pressable>

      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <KeyboardAvoidingView
          style={styles.modalRoot}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={[styles.sheet, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Trading assistant</Text>
              <View style={styles.headerActions}>
                <Pressable onPress={clearChat} hitSlop={8}>
                  <Feather name="rotate-ccw" size={20} color={C.textSecondary} />
                </Pressable>
                <Pressable onPress={() => setOpen(false)} hitSlop={8}>
                  <Feather name="x" size={22} color={C.text} />
                </Pressable>
              </View>
            </View>

            <ScrollView
              ref={scrollRef}
              style={styles.messages}
              contentContainerStyle={styles.messagesContent}
              onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
            >
              {messages.map((m) => (
                <View
                  key={m.id}
                  style={[
                    styles.bubble,
                    m.role === "user" ? styles.bubbleUser : styles.bubbleAssistant,
                  ]}
                >
                  <Text style={[styles.bubbleText, m.role === "user" && styles.bubbleTextUser]}>
                    {m.content}
                  </Text>
                </View>
              ))}
              {sending && (
                <View style={[styles.bubble, styles.bubbleAssistant]}>
                  <ActivityIndicator size="small" color={C.gold} />
                </View>
              )}
            </ScrollView>

            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                placeholder="Ask about cascades, TPs, zones…"
                placeholderTextColor={C.textMuted}
                value={input}
                onChangeText={setInput}
                multiline
                maxLength={500}
              />
              <Pressable
                style={[styles.sendBtn, (!input.trim() || sending) && styles.sendBtnDisabled]}
                onPress={handleSend}
                disabled={!input.trim() || sending}
              >
                <Feather name="send" size={18} color="#000" />
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    right: 16,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: C.gold,
    alignItems: "center",
    justifyContent: "center",
    elevation: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    zIndex: 100,
  },
  modalRoot: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: C.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    maxHeight: "88%",
    minHeight: "55%",
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  sheetTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: C.text,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  messages: {
    flex: 1,
  },
  messagesContent: {
    padding: 16,
    gap: 10,
  },
  bubble: {
    maxWidth: "85%",
    padding: 12,
    borderRadius: 14,
  },
  bubbleUser: {
    alignSelf: "flex-end",
    backgroundColor: C.gold,
  },
  bubbleAssistant: {
    alignSelf: "flex-start",
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  bubbleText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: C.text,
    lineHeight: 20,
  },
  bubbleTextUser: {
    color: "#000",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 100,
    backgroundColor: C.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: C.text,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: C.gold,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
});
