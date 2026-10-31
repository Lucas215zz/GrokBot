import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet, KeyboardAvoidingView,
  Platform, Modal, ScrollView, ActivityIndicator,
} from "react-native";
import { palette } from "../theme";
import { BotAvatar } from "../components";
import { newId } from "../../core/util";

export default function ChatScreen({ orch, theme, bot, onBack, onRefresh }) {
  const c = palette(theme);
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [runningRunId, setRunningRunId] = useState(null);
  const [approval, setApproval] = useState(null);
  const [showSessions, setShowSessions] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [skills, setSkills] = useState([]);
  const listRef = useRef(null);
  const activeRunRef = useRef(null);

  const loadSessions = useCallback(async (preferredId) => {
    const list = await orch.store.listSessions(bot.id);
    setSessions(list);
    if (list.length) {
      const active =
        (preferredId && list.find((s) => s.id === preferredId) ? preferredId : null) ||
        (sessionId && list.find((s) => s.id === sessionId) ? sessionId : null) ||
        list[0].id;
      setSessionId(active);
      const s = await orch.store.getSession(bot.id, active);
      setMessages(s ? s.messages : []);
    } else {
      setSessionId(null);
      setMessages([]);
    }
  }, [bot.id, sessionId]);

  useEffect(() => {
    loadSessions();
    setSkills(orch.skillStore.list());
  }, [bot.id]);

  // 订阅 agent 事件
  useEffect(() => {
    const handler = ({ runId, ...ev }) => {
      if (runId !== activeRunRef.current) return;
      if (ev.type === "text") {
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last && last.streaming) {
            last.content += ev.delta;
            copy[copy.length - 1] = { ...last };
          } else {
            copy.push({ role: "assistant", content: ev.delta, streaming: true });
          }
          return copy;
        });
      } else if (ev.type === "tool_call") {
        setMessages((prev) => [...prev, { type: "tool_call", name: ev.name, arguments: ev.arguments, callId: ev.callId }]);
      } else if (ev.type === "tool_result") {
        setMessages((prev) => [...prev, { type: "tool_result", name: ev.name, output: ev.output, callId: ev.callId }]);
      } else if (ev.type === "error") {
        setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ ${ev.message}`, error: true }]);
      } else if (ev.type === "done" || ev.type === "aborted" || ev.type === "max_steps") {
        setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
      }
    };
    orch.onEvent({ agent: handler });
    return () => orch.onEvent({ agent: null });
  }, []);

  // 订阅审批事件
  useEffect(() => {
    const handler = (ev) => {
      if (ev.type === "approval_request") setApproval(ev.request);
      else if (ev.type === "approval_resolved") setApproval((prev) => (prev && prev.id === ev.id ? null : prev));
    };
    orch.onEvent({ approval: handler });
    return () => orch.onEvent({ approval: null });
  }, []);

  const newSession = async () => {
    const s = await orch.store.createSession(bot.id);
    setSessionId(s.id);
    setMessages([]);
    await loadSessions(s.id);
  };

  const deleteSession = (id) => {
    if (sessions.length <= 1) return;
    orch.store.deleteSession(bot.id, id).then(loadSessions);
  };

  const send = async (textOverride) => {
    const text = (textOverride ?? input).trim();
    if (!text || running) return;
    setInput("");
    let sid = sessionId;
    if (!sid) {
      const s = await orch.store.createSession(bot.id);
      sid = s.id;
      setSessionId(sid);
    }
    const runId = "run-" + newId();
    activeRunRef.current = runId;
    setRunningRunId(runId);
    setRunning(true);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    const result = await orch.run({ runId, botId: bot.id, sessionId: sid, text });
    if (result.maxStepsReached || result.message) {
      // 错误/未完成已通过事件写入；这里补一条收尾
    }
    setRunning(false);
    setRunningRunId(null);
    activeRunRef.current = null;
    await loadSessions();
    onRefresh?.();
  };

  const stop = () => {
    if (runningRunId) orch.stop(runningRunId);
  };

  const resolveApproval = (decision, scope) => {
    if (approval) {
      orch.approvals.resolve(approval.id, decision, scope);
      setApproval(null);
    }
  };

  const renderMessage = ({ item }) => {
    if (item.type === "tool_call") {
      return (
        <View style={[styles.toolCall, { borderColor: c.border }]}>
          <Text style={[styles.toolName, { color: c.accent }]}>⚙ {item.name}</Text>
        </View>
      );
    }
    if (item.type === "tool_result") {
      return (
        <View style={[styles.toolResult, { backgroundColor: c.surfaceAlt }]}>
          <Text style={[styles.toolResultText, { color: c.textMuted }]} numberOfLines={6}>
            {item.output}
          </Text>
        </View>
      );
    }
    const isUser = item.role === "user";
    return (
      <View style={[styles.msgRow, isUser ? styles.msgRowUser : styles.msgRowBot]}>
        {!isUser && <BotAvatar emoji={bot.emoji} color={bot.color} size={30} />}
        <View style={[styles.bubble, isUser ? { backgroundColor: c.accent } : { backgroundColor: c.surface, borderColor: c.border, borderWidth: 1 }]}>
          <Text style={[styles.bubbleText, { color: isUser ? "#fff" : c.text }, item.error && { color: c.danger }]}>
            {item.content}
            {item.streaming && "▍"}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: c.bg }]} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <TouchableOpacity onPress={onBack} style={{ paddingRight: 8 }}>
          <Text style={[styles.backBtn, { color: c.accent }]}>‹</Text>
        </TouchableOpacity>
        <BotAvatar emoji={bot.emoji} color={bot.color} size={32} />
        <TouchableOpacity onPress={() => setShowSessions(true)} style={{ flex: 1, marginLeft: 10 }}>
          <Text style={[styles.headerName, { color: c.text }]} numberOfLines={1}>{bot.name}</Text>
          <Text style={[styles.headerDesc, { color: c.textMuted }]} numberOfLines={1}>{bot.description || "对话中"}</Text>
        </TouchableOpacity>
        {running && (
          <TouchableOpacity onPress={stop} style={[styles.stopBtn, { backgroundColor: c.danger }]}>
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: 12 }}>停止</Text>
          </TouchableOpacity>
        )}
      </View>

      {messages.length === 0 && !running ? (
        <View style={styles.emptyWrap}>
          <Text style={[styles.emptyText, { color: c.textMuted }]}>发一条消息，或长按下方技能快捷入口。</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(_, i) => String(i)}
          renderItem={renderMessage}
          contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        />
      )}

      <View style={[styles.composer, { borderColor: c.border, backgroundColor: c.surface }]}>
        <TouchableOpacity onPress={() => { setSkills(orch.skillStore.list()); setShowSkills(true); }} style={{ paddingRight: 8 }}>
          <Text style={{ fontSize: 18 }}>@</Text>
        </TouchableOpacity>
        <TextInput
          style={[styles.input, { color: c.text }]}
          value={input}
          onChangeText={setInput}
          placeholder="给 Bot 发消息…"
          placeholderTextColor={c.textMuted}
          multiline
          onSubmitEditing={() => send()}
          blurOnSubmit={false}
        />
        <TouchableOpacity onPress={() => send()} disabled={!input.trim() || running} style={[styles.sendBtn, { backgroundColor: input.trim() && !running ? c.accent : c.border }]}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>↑</Text>
        </TouchableOpacity>
      </View>

      {/* 会话切换 */}
      <Modal visible={showSessions} transparent animationType="slide">
        <View style={styles.overlay}>
          <View style={[styles.sheet, { backgroundColor: c.surface }]}>
            <View style={styles.sheetHead}>
              <Text style={[styles.sheetTitle, { color: c.text }]}>对话</Text>
              <TouchableOpacity onPress={() => setShowSessions(false)}><Text style={{ color: c.text, fontSize: 20 }}>✕</Text></TouchableOpacity>
            </View>
            <ScrollView>
              {sessions.map((s) => (
                <View key={s.id} style={[styles.sessionRow, { borderColor: c.border }, s.id === sessionId && { backgroundColor: c.surfaceAlt }]}>
                  <TouchableOpacity style={{ flex: 1 }} onPress={() => { setSessionId(s.id); setShowSessions(false); loadSessions(s.id); }}>
                    <Text style={{ color: c.text, fontWeight: "600" }} numberOfLines={1}>{s.title}</Text>
                    <Text style={{ color: c.textMuted, fontSize: 12 }}>{s.messageCount} 条消息</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => deleteSession(s.id)}><Text style={{ color: c.danger }}>删除</Text></TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity onPress={newSession} style={[styles.newSessionBtn, { backgroundColor: c.accent }]}>
                <Text style={{ color: "#fff", fontWeight: "700" }}>＋ 新对话</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* 技能快捷 */}
      <Modal visible={showSkills} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={[styles.sheet, { backgroundColor: c.surface }]}>
            <View style={styles.sheetHead}>
              <Text style={[styles.sheetTitle, { color: c.text }]}>技能（@ 调用）</Text>
              <TouchableOpacity onPress={() => setShowSkills(false)}><Text style={{ color: c.text, fontSize: 20 }}>✕</Text></TouchableOpacity>
            </View>
            {skills.length === 0 ? (
              <Text style={{ color: c.textMuted, padding: 16 }}>暂无技能。可在设置里创建。</Text>
            ) : (
              skills.map((s) => (
                <TouchableOpacity key={s.id} onPress={() => { setInput((v) => v + "@" + s.name + " "); setShowSkills(false); }}>
                  <View style={{ paddingVertical: 10 }}>
                    <Text style={{ color: c.text, fontWeight: "600" }}>@{s.name}</Text>
                    <Text style={{ color: c.textMuted, fontSize: 12 }} numberOfLines={1}>{s.description}</Text>
                  </View>
                </TouchableOpacity>
              ))
            )}
          </View>
        </View>
      </Modal>

      {/* 审批弹窗 */}
      <Modal visible={!!approval} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={[styles.sheet, { backgroundColor: c.surface }]}>
            <Text style={[styles.sheetTitle, { color: c.danger }]}>⚠️ 需要审批</Text>
            {approval && (
              <>
                <Text style={[styles.approvalLabel, { color: c.textMuted }]}>
                  工具：{approval.tool}（{approval.label}）
                </Text>
                <Text style={{ color: c.text, marginTop: 4 }}>{approval.reason}</Text>
                <ScrollView style={{ maxHeight: 200, marginTop: 8 }}>
                  <Text style={[styles.approvalDetail, { color: c.textMuted }]}>{approval.detail}</Text>
                </ScrollView>
                <View style={{ marginTop: 16, gap: 8 }}>
                  <TouchableOpacity onPress={() => resolveApproval("allow", "session")} style={[styles.approveBtn, { backgroundColor: c.ok }]}>
                    <Text style={{ color: "#fff", fontWeight: "700" }}>允许（本会话）</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => resolveApproval("allow", "once")} style={[styles.approveBtn, { backgroundColor: c.accent }]}>
                    <Text style={{ color: "#fff", fontWeight: "700" }}>允许一次</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => resolveApproval("deny", "once")} style={[styles.approveBtn, { backgroundColor: c.danger }]}>
                    <Text style={{ color: "#fff", fontWeight: "700" }}>拒绝</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1 },
  backBtn: { fontSize: 30, fontWeight: "700", lineHeight: 32 },
  headerName: { fontSize: 15, fontWeight: "700" },
  headerDesc: { fontSize: 12 },
  stopBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyText: { fontSize: 14 },
  composer: { flexDirection: "row", alignItems: "flex-end", padding: 8, borderTopWidth: 1 },
  input: { flex: 1, fontSize: 15, maxHeight: 100, paddingHorizontal: 4, paddingVertical: 6 },
  sendBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", marginLeft: 4 },
  msgRow: { flexDirection: "row", marginBottom: 10, alignItems: "flex-end" },
  msgRowUser: { justifyContent: "flex-end" },
  msgRowBot: { justifyContent: "flex-start" },
  bubble: { padding: 10, borderRadius: 14, maxWidth: "80%", marginLeft: 8 },
  bubbleText: { fontSize: 15, lineHeight: 21 },
  toolCall: { padding: 8, borderRadius: 8, borderWidth: 1, marginVertical: 2, alignSelf: "flex-start" },
  toolName: { fontSize: 12, fontWeight: "700" },
  toolResult: { padding: 8, borderRadius: 8, marginVertical: 2, alignSelf: "flex-start", maxWidth: "90%" },
  toolResultText: { fontSize: 12, lineHeight: 16 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: "85%" },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  sheetTitle: { fontSize: 18, fontWeight: "800" },
  sessionRow: { flexDirection: "row", alignItems: "center", padding: 12, borderRadius: 10, borderWidth: 1, marginBottom: 8 },
  newSessionBtn: { paddingVertical: 12, borderRadius: 10, alignItems: "center", marginTop: 8 },
  approvalLabel: { fontSize: 13, fontWeight: "600" },
  approvalDetail: { fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", lineHeight: 16 },
  approveBtn: { paddingVertical: 12, borderRadius: 10, alignItems: "center" },
});
