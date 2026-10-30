#!/bin/bash
#
# Grok Bot —— 让 Mac 当「云电脑」时保持常醒
#
# 云电脑要 24h 在线，但 Mac 默认会：空闲睡眠、合盖睡眠、显示器睡眠。
# 浏览器自动化还必须跑在「已登录的 GUI 会话」里，所以还需要开自动登录。
#
# 用法：
#   bash deploy/macos/keep-awake.sh            # 应用设置
#   bash deploy/macos/keep-awake.sh --revert   # 还原成系统默认
#   bash deploy/macos/keep-awake.sh --status   # 查看当前设置
#
set -euo pipefail

say() { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
ok()  { printf "\033[1;32m  ✓\033[0m %s\n" "$*"; }

case "${1:-}" in
  --status)
    say "电源设置"
    pmset -g custom
    echo
    say "自动登录（需 root 读，可能为空）"
    sudo defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || echo "  未设置 / 无权限"
    exit 0
    ;;
  --revert)
    say "还原电源设置为系统默认"
    sudo pmset -a sleep 1 displaysleep 10 disksleep 10
    ok "已还原（合盖仍可能睡眠，需手动在 设置→电池 里改回）"
    exit 0
    ;;
esac

say "关闭睡眠（插电 + 电池都关）"
sudo pmset -a sleep 0 displaysleep 0 disksleep 0
ok "sleep=0 displaysleep=0 disksleep=0"

say "合盖不休眠（仅插电时生效；笔记本合盖通常仍需外接电源）"
sudo pmset -c disablesleep 1 2>/dev/null && ok "disablesleep=1（插电）" || \
  echo "  这台机型不支持 disablesleep，合盖会睡；建议开盖放着或用 caffeinate"

say "断电重启后自动恢复（模拟断电）"
sudo pmset -a autorestart 1 2>/dev/null && ok "autorestart=1" || true

cat <<'EOF'

────────────────────────────────────────────────
 还需要手动做两件事（脚本改不了，涉及系统安全）：

 1) 开「自动登录」，重启后能自动进桌面：
      系统设置 → 用户与群组 → 自动登录 → 选你的账号
    （若没有该选项，先关闭「文件保险箱 FileVault」或改用
      「登录项」+ 免密登录方案）

 2) 关掉「锁定屏幕后需要密码」的长时间锁定，或延长到很长：
      系统设置 → 锁定屏幕 → 要求密码：改为「永不」或 8 小时

 验证：
   pmset -g custom         # 看 sleep / displaysleep 是否为 0
   bash deploy/macos/keep-awake.sh --status
────────────────────────────────────────────────
EOF
