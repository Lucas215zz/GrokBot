#!/bin/bash
#
# Grok Bot —— macOS 云计算机一键部署
#
# 做四件事：
#   1. 生成服务端配置 + 随机 token
#   2. 装 LaunchAgent（开机自启、崩溃自动拉起）
#   3. 启动服务并自检
#   4. 打印 App 里要填的地址和 token
#
# 用法：
#   bash deploy/macos/setup.sh              # 安装
#   bash deploy/macos/setup.sh --uninstall  # 卸载
#   bash deploy/macos/setup.sh --status     # 看状态
#
set -euo pipefail

LABEL="com.grokbot.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/grokbot"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER="$REPO/server/grok-server.js"
PORT=8787

say() { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
ok()  { printf "\033[1;32m  ✓\033[0m %s\n" "$*"; }
err() { printf "\033[1;31m  ✗\033[0m %s\n" "$*" >&2; }

find_node() {
  for c in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

case "${1:-}" in
  --uninstall)
    say "卸载 LaunchAgent"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    ok "已卸载（数据保留在 ~/.grokbot-server）"
    exit 0
    ;;
  --status)
    say "服务状态"
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E 'state|pid|last exit' || echo "  未加载"
    echo
    say "健康检查"
    TOKEN="$(node "$SERVER" --print-token 2>/dev/null || true)"
    if [ -n "$TOKEN" ]; then
      curl -sS -m 5 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health" || echo "  连不上"
      echo
    fi
    exit 0
    ;;
esac

say "检查环境"
NODE="$(find_node)" || { err "找不到 node，请先装 Node.js 22+（brew install node）"; exit 1; }
ok "node: $NODE ($("$NODE" -v))"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  err "node 版本过低（$("$NODE" -v)）：浏览器自动化需要 Node 22+（全局 WebSocket）。"
  err "文件/命令功能仍可用，但 browser_* 会报错。建议 brew upgrade node。"
fi
[ -f "$SERVER" ] || { err "找不到 $SERVER"; exit 1; }
ok "服务端: $SERVER"

say "初始化配置"
"$NODE" "$SERVER" --init
mkdir -p "$LOG_DIR"

say "安装 LaunchAgent"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE|g" \
    -e "s|__SERVER__|$SERVER|g" \
    -e "s|__REPO__|$REPO|g" \
    -e "s|__LOG__|$LOG_DIR|g" \
    "$REPO/deploy/macos/com.grokbot.server.plist" > "$PLIST"
chmod 644 "$PLIST"
ok "已写入 $PLIST"

say "启动服务"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
sleep 2

say "自检"
TOKEN="$("$NODE" "$SERVER" --print-token)"
if curl -sS -m 5 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'; then
  ok "服务已就绪"
else
  err "服务没起来，看日志：$LOG_DIR/grok-server.err.log"
  tail -20 "$LOG_DIR/grok-server.err.log" 2>/dev/null || true
  exit 1
fi

cat <<EOF

────────────────────────────────────────────────
 在另一台电脑的 Grok Bot 里填：

   设置 → 执行环境 → 云计算机
   地址： http://127.0.0.1:$PORT     ← 本机调试用
   Token：$TOKEN

 走 Cloudflare Tunnel 时，地址换成：
   https://grok.你的域名.com

 日志： $LOG_DIR/grok-server.out.log
        $LOG_DIR/grok-server.err.log

 重启： launchctl kickstart -k gui/$(id -u)/$LABEL
 状态： bash deploy/macos/setup.sh --status
────────────────────────────────────────────────
EOF
