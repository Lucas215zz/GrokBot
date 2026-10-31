import React, { useState, useEffect } from "react";
import { SafeAreaView, StyleSheet, View, Text, ActivityIndicator } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Orchestrator } from "./src/core/orchestrator";
import { palette } from "./src/ui/theme";
import BotsScreen from "./src/ui/screens/BotsScreen";
import ChatScreen from "./src/ui/screens/ChatScreen";
import SettingsScreen from "./src/ui/screens/SettingsScreen";

let orchSingleton = null;
function getOrch() {
  if (!orchSingleton) orchSingleton = new Orchestrator();
  return orchSingleton;
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState("bots"); // bots | chat | settings
  const [activeBot, setActiveBot] = useState(null);
  const [theme, setTheme] = useState("dark");

  useEffect(() => {
    (async () => {
      const orch = getOrch();
      await orch.init();
      setTheme(orch.store.getApp().ui?.theme || "dark");
      setReady(true);
    })();
  }, []);

  if (!ready) {
    return (
      <View style={[styles.center, { backgroundColor: "#0b0b0d" }]}>
        <ActivityIndicator size="large" color="#6b4eff" />
        <Text style={{ color: "#9a9aa3", marginTop: 12 }}>Grok Bot 启动中…</Text>
      </View>
    );
  }

  const orch = getOrch();
  const c = palette(theme);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.safe, { backgroundColor: c.bg }]} edges={["top", "bottom"]}>
        <StatusBar style={theme === "dark" ? "light" : "dark"} />
        {screen === "bots" && (
          <BotsScreen
            orch={orch}
            theme={theme}
            onOpenBot={(bot) => {
              setActiveBot(bot);
              setScreen("chat");
            }}
            onOpenSettings={() => setScreen("settings")}
            onRefresh={() => setTheme(orch.store.getApp().ui?.theme || theme)}
          />
        )}
        {screen === "chat" && activeBot && (
          <ChatScreen
            orch={orch}
            theme={theme}
            bot={activeBot}
            onBack={() => setScreen("bots")}
            onRefresh={() => setTheme(orch.store.getApp().ui?.theme || theme)}
          />
        )}
        {screen === "settings" && (
          <SettingsScreen
            orch={orch}
            theme={theme}
            onBack={() => {
              setTheme(orch.store.getApp().ui?.theme || theme);
              setScreen("bots");
            }}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
