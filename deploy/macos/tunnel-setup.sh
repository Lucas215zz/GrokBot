#!/bin/bash
#
# Grok Bot —— Cloudflare Tunnel 一键部署（把本机 grok-server 安全暴露到公网）
#
# 为什么用 Tunnel：
#   cloudflared 从 Mac「主动向外」连 Cloudflare 边缘，
#   所以 不需要公网 IP、不需要端口映射、不需要 DDNS。
#   运营商封 80/443、IP 天天变，都无所谓。
#
# 前置：先在 Cloudflare 托管一个域名（Nameserver 指向 CF），并且已执行过
#       bash deploy/macos/setup.sh（本机 grok-server 已在 127.0.0.1:8787 跑起来）。
#
# 用法：
#   bash deploy/macos/tunnel-setup.sh <你的域名>        # 例如 grok.example.com
#   bash deploy/macos/tunnel-setup.sh --uninstall
#   bash deploy/macos/tunnel-setup.sh --status
#
set -euo pipefail

LABEL="com.grokbot.tunnel"
TUNNEL_NAME="grokbot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CF_DIR="$HOME/.cloudflared"
LOG_DIR="$HOME/Library/Logs/grokbot"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT=8787

say() { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
ok()  { printf "\033[1;32m  ✓\033[0m %s\n" "$*"; }
err() { printf "\033[1;31m  ✗\033[0m %s\n" "$*" >&2; }

find_cloudflared() {
  for c in "$(command -v cloudflared 2>/dev/null || true)" /opt/homebrew/bin/cloudflared /usr/local/bin/cloudflared; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

case "${1:-}" in
  --uninstall)
    say "卸载 Tunnel LaunchAgent"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    ok "已卸载（cloudflared 的 DNS 记录与 tunnel 仍保留，可在 Cloudflare 面板删除）"
    exit 0
    ;;
  --status)
    say "Tunnel 状态"
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E 'state|pid|last exit' || echo "  未加载"
    echo
    CF="$(find_cloudflared)" && "$CF" tunnel info "$TUNNEL_NAME" 2>/dev/null || true
    exit 0
    ;;
esac

HOSTNAME="${1:-}"
[ -n "$HOSTNAME" ] || { err "用法：bash deploy/macos/tunnel-setup.sh <你的域名>，例如 grok.example.com"; exit 1; }

say "检查环境"
CF="$(find_cloudflared)" || {
  say "未找到 cloudflared，尝试用 Homebrew 安装"
  command -v brew >/dev/null 2>&1 || { err "也没找到 Homebrew。请先装：https://brew.sh"; exit 1; }
  brew install cloudflared
  CF="$(find_cloudflared)" || { err "安装后仍找不到 cloudflared"; exit 1; }
}
ok "cloudflared: $CF ($("$CF" --version))"

# 确认本机服务在跑
if ! curl -sS -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  err "本机 $PORT 没起来。先跑：bash deploy/macos/setup.sh"
  exit 1
fi
ok "本机 grok-server 已监听 127.0.0.1:$PORT"

mkdir -p "$CF_DIR" "$LOG_DIR"

say "登录 Cloudflare（会打开浏览器授权，选你要用的那个域名）"
if [ ! -f "$CF_DIR/cert.pem" ]; then
  "$CF" tunnel login
else
  ok "已存在 cert.pem，跳过登录"
fi

say "创建 Tunnel：$TUNNEL_NAME"
if "$CF" tunnel info "$TUNNEL_NAME" >/dev/null 2>&1; then
  ok "Tunnel 已存在，复用"
else
  "$CF" tunnel create "$TUNNEL_NAME"
fi

TUNNEL_ID="$("$CF" tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n {print $1; exit}')"
[ -n "$TUNNEL_ID" ] || { err "拿不到 tunnel id，请手动检查：$CF tunnel list"; exit 1; }
CREDENTIALS="$CF_DIR/$TUNNEL_ID.json"
[ -f "$CREDENTIALS" ] || { err "找不到凭据文件 $CREDENTIALS"; exit 1; }
ok "tunnel id: $TUNNEL_ID"
ok "凭据: $CREDENTIALS"

say "绑定域名：$HOSTNAME → $TUNNEL_NAME"
DNS_LOG="/tmp/grokbot-dns.log"
if "$CF" tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" 2>&1 | tee "$DNS_LOG"; then
  ok "DNS 已绑定"
elif grep -qi "already exists" "$DNS_LOG"; then
  # 很常见：DNSPod 解析里已经有一条同名记录（例如之前手建的 A 记录）。
  # 这种情况 cloudflared 会报错，需要人工处理，不能当成成功。
  err "DNS 记录已存在，但可能指向旧地址（比如之前手建的 A 记录）。"
  err "请到 Cloudflare 面板 → DNS 删除 $HOSTNAME 的旧记录后重跑本脚本；"
  err "或手动执行：$CF tunnel route dns $TUNNEL_NAME $HOSTNAME"
  exit 1
else
  err "绑定 DNS 失败，请手动执行：$CF tunnel route dns $TUNNEL_NAME $HOSTNAME"
  exit 1
fi

say "生成 $CF_DIR/config.yml"
sed -e "s|__TUNNEL_ID__|$TUNNEL_ID|g" \
    -e "s|__CREDENTIALS__|$CREDENTIALS|g" \
    -e "s|__HOSTNAME__|$HOSTNAME|g" \
    "$REPO/deploy/cloudflare/config.yml" > "$CF_DIR/config.yml"
chmod 600 "$CF_DIR/config.yml"
ok "已写入 $CF_DIR/config.yml"

say "安装 Tunnel LaunchAgent（开机自启、崩溃自动拉起）"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CF</string>
    <string>--config</string>
    <string>$CF_DIR/config.yml</string>
    <string>tunnel</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/tunnel.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/tunnel.err.log</string>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
PLIST_EOF
chmod 644 "$PLIST"
ok "已写入 $PLIST"

say "启动 Tunnel"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
sleep 3

say "自检"
TOKEN="$(node "$REPO/server/grok-server.js" --print-token 2>/dev/null || true)"
if [ -n "$TOKEN" ] && curl -sS -m 10 -H "Authorization: Bearer $TOKEN" "https://$HOSTNAME/health" | grep -q '"ok":true'; then
  ok "公网可访问：https://$HOSTNAME/health"
else
  err "公网自检没通过，看日志：$LOG_DIR/tunnel.err.log"
  tail -20 "$LOG_DIR/tunnel.err.log" 2>/dev/null || true
  echo
  echo "  DNS 可能还没生效（通常 1-2 分钟），稍后手动重试："
  echo "    curl -H 'Authorization: Bearer $TOKEN' https://$HOSTNAME/health"
fi

cat <<EOF

────────────────────────────────────────────────
 Cloudflare Tunnel 已配置

 在另一台电脑的 Grok Bot 里填：

   设置 → 执行环境 → 云计算机
   地址： https://$HOSTNAME
   Token：${TOKEN:-<在 Mac 上跑: node server/grok-server.js --print-token>}

 ⚠️ 强烈建议再加一层 Zero Trust Access（免费）：
   Cloudflare 面板 → Zero Trust → Access → Applications
   → Add an application → Self-hosted
   → 域名填 $HOSTNAME
   → 策略：Allow，条件选 Emails = 你自己的邮箱
   → 这样即使地址泄露，别人也进不来（会先要求邮箱验证码）。

 日志： $LOG_DIR/tunnel.out.log
        $LOG_DIR/tunnel.err.log
 重启： launchctl kickstart -k gui/$(id -u)/$LABEL
 状态： bash deploy/macos/tunnel-setup.sh --status
────────────────────────────────────────────────
EOF
