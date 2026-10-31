# Grok Bot 手机端

桌面版（Electron）的手机端移植，基于 **Expo / React Native**。

核心 Agent 引擎（模型流式调用、Agent 循环、工具执行、审批边界、技能、长期记忆、
Bot 协作、云计算机）全部跑在手机上，直接连 Responses API 兼容服务。

## 架构对照

| 桌面版 (Electron) | 手机端 (React Native) |
| --- | --- |
| `app/src/main/agent/model-client.js`（流式 fetch） | `src/core/model-client.js` + `src/core/sse.js`（XHR 增量解析 SSE） |
| `app/src/main/agent/loop.js` | `src/core/loop.js` |
| `app/src/main/tools/registry.js` / `executor.js` | `src/core/registry.js` / `executor.js` |
| `app/src/main/approval/policy.js` / `approval-manager.js` | `src/core/policy.js` / `approval-manager.js` |
| `app/src/main/computer/*`（fs + PowerShell） | `src/core/computer.js` + `local-computer.js`（expo-file-system 沙箱）+ `remote-computer.js`（云计算机） |
| `app/src/main/store/store.js`（文件系统） | `src/store/store.js`（AsyncStorage） |
| `app/src/main/memory/*` / `skills/*` / `collab/*` | `src/store/*`（AsyncStorage） |
| `app/src/main/mcp/mcp-client.js`（stdio + http） | `src/core/mcp.js`（仅 http） |
| `app/src/main/main.js`（IPC 编排） | `src/core/orchestrator.js` |
| `app/src/renderer/*`（HTML/CSS/JS） | `src/ui/screens/*`（RN 组件） |

## 关键差异（手机端限制）

1. **流式输出**：RN 的 `fetch` 不支持读响应体流，改用 `XMLHttpRequest` 的
   `onprogress` 增量事件逐行解析 SSE（见 `src/core/sse.js`）。
2. **本机模式没有 shell / 浏览器**：手机本机计算机只有文档目录沙箱
   （`expo-file-system`），能读写文件、全文搜索，但 `run_command` / `browser_*`
   会返回明确错误。要完整能力，请在「设置 → 执行环境」切到**云计算机**
   （连桌面版同款的 `grok-server.js` 服务端，复用既有 HTTP 契约）。
3. **MCP 仅支持 http 传输**：stdio 需要本地进程，手机不支持。
4. **存储用 AsyncStorage**：Bot / 会话 / 技能 / 记忆 / 协作消息都持久化在设备本地。
5. **无后台常驻**：定时例程（Routines）在手机端暂未实现（移动 OS 不允许长时间后台），
   需要定时任务请用云计算机 + 服务端调度，或桌面版。

## 运行

```bash
cd mobile
npm install
npx expo start          # 用 Expo Go 扫码在真机运行，或按 a 跑 Android 模拟器
```

首次使用：右上角 ⚙️ 设置 → 填模型服务地址（默认 `http://127.0.0.1:8788/v1`，
真机上要改成电脑局域网 IP 或公网地址）→ 测试拉取模型 → 返回首页新建 Bot。

> 注意：真机访问电脑上的模型路由器时，`127.0.0.1` 指手机自己，要改成电脑的局域网 IP，
> 且模型服务需监听 `0.0.0.0`。

## 云计算机（可选）

手机想拥有完整 shell / 浏览器能力，就复用桌面版服务端：

1. 在一台常开的机器（或 Mac + Cloudflare Tunnel）上跑 `server/grok-server.js`；
2. 手机端「设置 → 执行环境 → 云计算机」填 `https://…` + token；
3. 之后所有 Bot 的 `run_command` / `browser_*` 都在云端执行，文件按 botId 隔离。

契约见仓库根目录 `docs/cloud-computer.md`。
