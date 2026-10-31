import React, { useState } from "react";
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet, Modal, Alert } from "react-native";
import { palette } from "../theme";
import { BotAvatar } from "../components";

export default function BotsScreen({ orch, theme, onOpenBot, onOpenSettings, onRefresh }) {
  const c = palette(theme);
  const [bots, setBots] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🤖");
  const [desc, setDesc] = useState("");

  React.useEffect(() => {
    reload();
  }, []);

  const reload = () => {
    setBots(orch.store.listBots());
  };

  const createBot = async () => {
    if (!name.trim()) return Alert.alert("提示", "请填写名称");
    await orch.store.createBot({ name: name.trim(), emoji: emoji.trim() || "🤖", description: desc.trim() });
    setName("");
    setEmoji("🤖");
    setDesc("");
    setShowNew(false);
    reload();
    onRefresh?.();
  };

  const confirmDelete = (bot) => {
    Alert.alert("删除 Bot", `确定删除「${bot.name}」？其会话和工作文件将一并删除。`, [
      { text: "取消", style: "cancel" },
      { text: "删除", style: "destructive", onPress: async () => { await orch.store.deleteBot(bot.id); reload(); onRefresh?.(); } },
    ]);
  };

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: c.text }]}>Grok Bot</Text>
        <TouchableOpacity onPress={() => onOpenSettings()} style={[styles.settingsBtn, { borderColor: c.border }]}>
          <Text style={{ color: c.text }}>⚙️</Text>
        </TouchableOpacity>
      </View>

      <Text style={[styles.subtitle, { color: c.textMuted }]}>你的 Bot 团队</Text>

      {bots.length === 0 ? (
        <View style={styles.noBots}>
          <Text style={[styles.noBotsText, { color: c.textMuted }]}>还没有 Bot，点下面按钮创建第一个。</Text>
        </View>
      ) : (
        <FlatList
          data={bots}
          keyExtractor={(b) => b.id}
          contentContainerStyle={{ paddingBottom: 20 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.botRow, { backgroundColor: c.surface, borderColor: c.border }]}
              onPress={() => onOpenBot(item)}
              onLongPress={() => confirmDelete(item)}
            >
              <BotAvatar emoji={item.emoji} color={item.color} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={[styles.botName, { color: c.text }]}>{item.name}</Text>
                <Text style={[styles.botDesc, { color: c.textMuted }]} numberOfLines={1}>
                  {item.description || "无描述"}
                </Text>
              </View>
              <Text style={{ color: c.textMuted }}>›</Text>
            </TouchableOpacity>
          )}
        />
      )}

      <TouchableOpacity onPress={() => setShowNew(true)} style={[styles.newBtn, { backgroundColor: c.accent }]}>
        <Text style={[styles.newBtnText, { color: "#fff" }]}>＋ 新建 Bot</Text>
      </TouchableOpacity>

      <Modal visible={showNew} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modal, { backgroundColor: c.surface }]}>
            <Text style={[styles.modalTitle, { color: c.text }]}>新建 Bot</Text>
            <Text style={[styles.fieldLabel, { color: c.textMuted }]}>名称</Text>
            <TextInput style={[styles.input, { color: c.text, backgroundColor: c.inputBg, borderColor: c.border }]} value={name} onChangeText={setName} placeholder="例如：代码助手" placeholderTextColor={c.textMuted} />
            <Text style={[styles.fieldLabel, { color: c.textMuted }]}>头像 emoji</Text>
            <TextInput style={[styles.input, { color: c.text, backgroundColor: c.inputBg, borderColor: c.border }]} value={emoji} onChangeText={setEmoji} maxLength={4} />
            <Text style={[styles.fieldLabel, { color: c.textMuted }]}>一句话描述</Text>
            <TextInput style={[styles.input, { color: c.text, backgroundColor: c.inputBg, borderColor: c.border }]} value={desc} onChangeText={setDesc} placeholder="这个 Bot 负责什么" placeholderTextColor={c.textMuted} />
            <View style={styles.modalBtns}>
              <TouchableOpacity onPress={() => setShowNew(false)} style={[styles.cancelBtn, { borderColor: c.border }]}>
                <Text style={{ color: c.text }}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={createBot} style={[styles.saveBtn, { backgroundColor: c.accent }]}>
                <Text style={{ color: "#fff", fontWeight: "700" }}>创建</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 16 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12, marginBottom: 4 },
  title: { fontSize: 28, fontWeight: "800" },
  settingsBtn: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  subtitle: { fontSize: 13, marginBottom: 14 },
  noBots: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  noBotsText: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  botRow: { flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 14, borderWidth: 1, marginBottom: 10 },
  botName: { fontSize: 16, fontWeight: "700" },
  botDesc: { fontSize: 13, marginTop: 2 },
  newBtn: { paddingVertical: 14, borderRadius: 14, alignItems: "center", marginTop: "auto", marginBottom: 8 },
  newBtnText: { fontSize: 16, fontWeight: "700" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 20 },
  modal: { borderRadius: 16, padding: 20 },
  modalTitle: { fontSize: 20, fontWeight: "800", marginBottom: 16 },
  fieldLabel: { fontSize: 13, marginBottom: 6, marginTop: 10 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  modalBtns: { flexDirection: "row", gap: 10, marginTop: 20 },
  cancelBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, alignItems: "center" },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center" },
});
