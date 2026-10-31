import React, { useState, useEffect } from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Switch, Alert,
} from "react-native";
import { palette } from "../theme";
import { newId } from "../../core/util";

export default function SettingsScreen({ orch, theme, onBack }) {
  const c = palette(theme);
  const [provider, setProvider] = useState({ baseUrl: "", apiKey: "", model: "" });
  const [computer, setComputer] = useState({ kind: "local", baseUrl: "", token: "" });
  const [approvalMode, setApprovalMode] = useState("balanced");
  const [themeSel, setThemeSel] = useState(theme);
  const [modelList, setModelList] = useState([]);
  const [skills, setSkills] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [showNewSkill, setShowNewSkill] = useState(false);
  const [skillName, setSkillName] = useState("");
  const [skillDesc, setSkillDesc] = useState("");
  const [skillBody, setSkillBody] = useState("");
  const [showNewMcp, setShowNewMcp] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const app = orch.store.getApp();
    setProvider(app.provider);
    setComputer(app.computer);
    setApprovalMode(app.approval?.mode || "balanced");
    setThemeSel(app.ui?.theme || "dark");
    setSkills(orch.skillStore.list());
    setMcpServers(orch.mcpManager.servers);
  }, []);

  const saveProvider = async () => {
    await orch.store.updateApp({ provider });
    Alert.alert("已保存", "模型服务设置已保存");
  };

  const saveComputer = async () => {
    await orch.store.updateApp({ computer });
    Alert.alert("已保存", "执行环境设置已保存");
  };

  const saveApproval = async (mode) => {
    setApprovalMode(mode);
    await orch.store.updateApp({ approval: { mode } });
  };

  const saveTheme = async (t) => {
    setThemeSel(t);
    await orch.store.updateApp({ ui: { theme: t } });
  };

  const fetchModels = async () => {
    setTesting(true);
    try {
      const models = await orch.client.listModels(provider);
      setModelList(models);
      Alert.alert("连接成功", `获取到 ${models.length} 个模型`);
    } catch (e) {
      Alert.alert("连接失败", e.message);
    } finally {
      setTesting(false);
    }
  };

  const createSkill = async () => {
    if (!skillName.trim()) return Alert.alert("提示", "请填写技能名");
    await orch.skillStore.save(skillName.trim().replace(/\s+/g, "-").toLowerCase(), {
      name: skillName.trim(),
      description: skillDesc.trim(),
      body: skillBody,
    });
    setSkillName("");
    setSkillDesc("");
    setSkillBody("");
    setShowNewSkill(false);
    setSkills(orch.skillStore.list());
  };

  const deleteSkill = (id) => {
    Alert.alert("删除技能", "确定删除？", [
      { text: "取消", style: "cancel" },
      { text: "删除", style: "destructive", onPress: async () => { await orch.skillStore.remove(id); setSkills(orch.skillStore.list()); } },
    ]);
  };

  const addMcp = async () => {
    if (!mcpName.trim() || !mcpUrl.trim()) return Alert.alert("提示", "请填写名称和 URL");
    const servers = [...orch.mcpManager.servers, { name: mcpName.trim(), type: "http", url: mcpUrl.trim(), enabled: true }];
    await orch.mcpManager.save(servers);
    setMcpServers(orch.mcpManager.servers);
    setMcpName("");
    setMcpUrl("");
    setShowNewMcp(false);
    try {
      await orch.mcpManager.connect(mcpName.trim());
      Alert.alert("已连接", `工具数：${orch.mcpManager.clients.get(mcpName.trim())?.tools.length || 0}`);
    } catch (e) {
      Alert.alert("连接失败", e.message);
    }
  };

  const removeMcp = async (name) => {
    await orch.mcpManager.disconnect(name);
    const servers = orch.mcpManager.servers.filter((s) => s.name !== name);
    await orch.mcpManager.save(servers);
    setMcpServers(orch.mcpManager.servers);
  };

  const field = (label, value, onChange, placeholder, secure) => (
    <View style={{ marginBottom: 12 }}>
      <Text style={[styles.label, { color: c.textMuted }]}>{label}</Text>
      <TextInput
        style={[styles.input, { color: c.text, backgroundColor: c.inputBg, borderColor: c.border }]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.textMuted}
        secureTextEntry={secure}
        autoCapitalize="none"
      />
    </View>
  );

  const modes = [
    ["strict", "严格"],
    ["balanced", "标准"],
    ["relaxed", "宽松"],
    ["off", "关闭"],
  ];

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <TouchableOpacity onPress={onBack} style={{ paddingRight: 8 }}>
          <Text style={[styles.backBtn, { color: c.accent }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: c.text }]}>设置</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={[styles.section, { color: c.text }]}>模型服务</Text>
        {field("Base URL", provider.baseUrl, (v) => setProvider({ ...provider, baseUrl: v }), "http://127.0.0.1:8788/v1")}
        {field("API Key", provider.apiKey, (v) => setProvider({ ...provider, apiKey: v }), "api key", false)}
        {field("模型 ID", provider.model, (v) => setProvider({ ...provider, model: v }), "留空则从上游拉取")}
        <View style={{ flexDirection: "row", gap: 10 }}>
          <TouchableOpacity onPress={fetchModels} disabled={testing} style={[styles.btn, { backgroundColor: c.accent }]}>
            <Text style={{ color: "#fff", fontWeight: "700" }}>{testing ? "连接中…" : "测试并拉取模型"}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={saveProvider} style={[styles.btn, { backgroundColor: c.surface, borderColor: c.border, borderWidth: 1 }]}>
            <Text style={{ color: c.text, fontWeight: "700" }}>保存</Text>
          </TouchableOpacity>
        </View>
        {modelList.length > 0 && (
          <View style={{ marginTop: 10 }}>
            <Text style={[styles.label, { color: c.textMuted }]}>可用模型（点选填入）：</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
              {modelList.slice(0, 30).map((m) => (
                <TouchableOpacity key={m} onPress={() => setProvider({ ...provider, model: m })} style={[styles.chip, { borderColor: c.border }]}>
                  <Text style={{ color: provider.model === m ? c.accent : c.text, fontSize: 12 }}>{m}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        <Text style={[styles.section, { color: c.text, marginTop: 24 }]}>执行环境（计算机）</Text>
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
          {["local", "remote"].map((k) => (
            <TouchableOpacity key={k} onPress={() => setComputer({ ...computer, kind: k })} style={[styles.chip, { borderColor: c.border, backgroundColor: computer.kind === k ? c.accent : "transparent" }]}>
              <Text style={{ color: computer.kind === k ? "#fff" : c.text }}>{k === "local" ? "本机沙箱" : "云计算机"}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {computer.kind === "remote" && (
          <>
            {field("云计算机地址", computer.baseUrl, (v) => setComputer({ ...computer, baseUrl: v }), "https://vm.example.com")}
            {field("Token", computer.token, (v) => setComputer({ ...computer, token: v }), "token")}
          </>
        )}
        <Text style={[styles.hint, { color: c.textMuted }]}>
          本机沙箱：只能读写 App 内的文件，不能执行命令或开浏览器。云计算机：连到你部署的 grok-server，具备完整 shell / 浏览器能力。
        </Text>
        <TouchableOpacity onPress={saveComputer} style={[styles.btn, { backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, marginTop: 8 }]}>
          <Text style={{ color: c.text, fontWeight: "700" }}>保存执行环境</Text>
        </TouchableOpacity>

        <Text style={[styles.section, { color: c.text, marginTop: 24 }]}>审批策略</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {modes.map(([k, label]) => (
            <TouchableOpacity key={k} onPress={() => saveApproval(k)} style={[styles.chip, { borderColor: c.border, backgroundColor: approvalMode === k ? c.accent : "transparent" }]}>
              <Text style={{ color: approvalMode === k ? "#fff" : c.text }}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={[styles.hint, { color: c.textMuted, marginTop: 6 }]}>危险操作（删除/联网/系统变更）执行前会询问你；「永久拒绝」始终生效。</Text>

        <Text style={[styles.section, { color: c.text, marginTop: 24 }]}>外观</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {["dark", "light"].map((t) => (
            <TouchableOpacity key={t} onPress={() => saveTheme(t)} style={[styles.chip, { borderColor: c.border, backgroundColor: themeSel === t ? c.accent : "transparent" }]}>
              <Text style={{ color: themeSel === t ? "#fff" : c.text }}>{t === "dark" ? "深色" : "浅色"}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={[styles.section, { color: c.text, marginTop: 24 }]}>技能</Text>
        {skills.map((s) => (
          <View key={s.id} style={[styles.row, { borderColor: c.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.text, fontWeight: "600" }}>{s.name}</Text>
              <Text style={{ color: c.textMuted, fontSize: 12 }} numberOfLines={1}>{s.description}</Text>
            </View>
            <TouchableOpacity onPress={() => deleteSkill(s.id)}><Text style={{ color: c.danger }}>删除</Text></TouchableOpacity>
          </View>
        ))}
        <TouchableOpacity onPress={() => setShowNewSkill(true)} style={[styles.btn, { backgroundColor: c.accent, marginTop: 8 }]}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>＋ 新建技能</Text>
        </TouchableOpacity>

        <Text style={[styles.section, { color: c.text, marginTop: 24 }]}>MCP 服务器</Text>
        {mcpServers.map((s) => (
          <View key={s.name} style={[styles.row, { borderColor: c.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.text, fontWeight: "600" }}>{s.name}</Text>
              <Text style={{ color: c.textMuted, fontSize: 12 }} numberOfLines={1}>{s.url}</Text>
            </View>
            <TouchableOpacity onPress={() => removeMcp(s.name)}><Text style={{ color: c.danger }}>移除</Text></TouchableOpacity>
          </View>
        ))}
        <TouchableOpacity onPress={() => setShowNewMcp(true)} style={[styles.btn, { backgroundColor: c.accent, marginTop: 8 }]}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>＋ 添加 MCP</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* 新建技能 */}
      {showNewSkill && (
        <View style={styles.modalOverlay}>
          <View style={[styles.modal, { backgroundColor: c.surface }]}>
            <Text style={[styles.modalTitle, { color: c.text }]}>新建技能</Text>
            <Text style={[styles.label, { color: c.textMuted }]}>名称（英文 id）</Text>
            <TextInput style={[styles.input, { color: c.text, backgroundColor: c.inputBg, borderColor: c.border }]} value={skillName} onChangeText={setSkillName} placeholder="daily-report" placeholderTextColor={c.textMuted} />
            <Text style={[styles.label, { color: c.textMuted, marginTop: 8 }]}>描述</Text>
            <TextInput style={[styles.input, { color: c.text, backgroundColor: c.inputBg, borderColor: c.border }]} value={skillDesc} onChangeText={setSkillDesc} placeholder="什么时候用" placeholderTextColor={c.textMuted} />
            <Text style={[styles.label, { color: c.textMuted, marginTop: 8 }]}>正文步骤</Text>
            <TextInput style={[styles.input, styles.multiline, { color: c.text, backgroundColor: c.inputBg, borderColor: c.border }]} value={skillBody} onChangeText={setSkillBody} placeholder="1. …\n2. …" placeholderTextColor={c.textMuted} multiline />
            <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
              <TouchableOpacity onPress={() => setShowNewSkill(false)} style={[styles.btn, { flex: 1, backgroundColor: c.surface, borderColor: c.border, borderWidth: 1 }]}><Text style={{ color: c.text }}>取消</Text></TouchableOpacity>
              <TouchableOpacity onPress={createSkill} style={[styles.btn, { flex: 1, backgroundColor: c.accent }]}><Text style={{ color: "#fff", fontWeight: "700" }}>保存</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* 添加 MCP */}
      {showNewMcp && (
        <View style={styles.modalOverlay}>
          <View style={[styles.modal, { backgroundColor: c.surface }]}>
            <Text style={[styles.modalTitle, { color: c.text }]}>添加 MCP（HTTP）</Text>
            <Text style={[styles.label, { color: c.textMuted }]}>名称</Text>
            <TextInput style={[styles.input, { color: c.text, backgroundColor: c.inputBg, borderColor: c.border }]} value={mcpName} onChangeText={setMcpName} placeholder="calc" placeholderTextColor={c.textMuted} />
            <Text style={[styles.label, { color: c.textMuted, marginTop: 8 }]}>URL</Text>
            <TextInput style={[styles.input, { color: c.text, backgroundColor: c.inputBg, borderColor: c.border }]} value={mcpUrl} onChangeText={setMcpUrl} placeholder="https://…/mcp" placeholderTextColor={c.textMuted} autoCapitalize="none" />
            <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
              <TouchableOpacity onPress={() => setShowNewMcp(false)} style={[styles.btn, { flex: 1, backgroundColor: c.surface, borderColor: c.border, borderWidth: 1 }]}><Text style={{ color: c.text }}>取消</Text></TouchableOpacity>
              <TouchableOpacity onPress={addMcp} style={[styles.btn, { flex: 1, backgroundColor: c.accent }]}><Text style={{ color: "#fff", fontWeight: "700" }}>连接</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1 },
  backBtn: { fontSize: 30, fontWeight: "700", lineHeight: 32 },
  title: { fontSize: 18, fontWeight: "800" },
  section: { fontSize: 16, fontWeight: "800", marginBottom: 12 },
  label: { fontSize: 13, marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  multiline: { minHeight: 90, textAlignVertical: "top" },
  btn: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  hint: { fontSize: 12, lineHeight: 17, marginTop: 6 },
  chip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1 },
  row: { flexDirection: "row", alignItems: "center", padding: 12, borderRadius: 10, borderWidth: 1, marginBottom: 8 },
  modalOverlay: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 20 },
  modal: { borderRadius: 16, padding: 20 },
  modalTitle: { fontSize: 18, fontWeight: "800", marginBottom: 12 },
});
