import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { palette } from "./theme";

export function BotAvatar({ emoji, color, size = 40 }) {
  return (
    <View style={[styles.avatar, { backgroundColor: color || "#6b4eff", width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={{ fontSize: size * 0.5 }}>{emoji || "🤖"}</Text>
    </View>
  );
}

export function SectionLabel({ text, theme }) {
  const c = palette(theme);
  return <Text style={[styles.sectionLabel, { color: c.textMuted }]}>{text}</Text>;
}

export function GhostButton({ label, onPress, theme, icon }) {
  const c = palette(theme);
  return (
    <TouchableOpacity onPress={onPress} style={[styles.ghostBtn, { borderColor: c.border, backgroundColor: c.surface }]}>
      <Text style={[styles.ghostText, { color: c.text }]}>{icon ? icon + " " : ""}{label}</Text>
    </TouchableOpacity>
  );
}

export function PrimaryButton({ label, onPress, theme, disabled }) {
  const c = palette(theme);
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[styles.primaryBtn, { backgroundColor: disabled ? c.border : c.accent, opacity: disabled ? 0.6 : 1 }]}
    >
      <Text style={[styles.primaryText, { color: "#fff" }]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function EmptyState({ theme, onPrompt }) {
  const c = palette(theme);
  const starters = [
    "看看工作目录里有什么文件",
    "帮我写一个任务清单文本文件",
    "给我讲讲你能做什么",
  ];
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: c.text }]}>给 Bot 一个任务</Text>
      <Text style={[styles.emptyHint, { color: c.textMuted }]}>每个 Bot 都有自己的工作目录，可以读写文件、执行命令（云计算机）。</Text>
      {starters.map((s) => (
        <TouchableOpacity key={s} onPress={() => onPrompt(s)} style={[styles.starter, { borderColor: c.border }]}>
          <Text style={{ color: c.text }}>{s}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: "center", justifyContent: "center" },
  sectionLabel: { fontSize: 12, fontWeight: "700", marginVertical: 8, marginHorizontal: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  ghostBtn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, flexDirection: "row", alignItems: "center" },
  ghostText: { fontSize: 14, fontWeight: "600" },
  primaryBtn: { paddingVertical: 12, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  primaryText: { fontSize: 15, fontWeight: "700" },
  empty: { flex: 1, paddingHorizontal: 24, justifyContent: "center" },
  emptyTitle: { fontSize: 22, fontWeight: "800", marginBottom: 6 },
  emptyHint: { fontSize: 14, lineHeight: 20, marginBottom: 18 },
  starter: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, marginBottom: 8 },
});
