#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.quanh.telegram-bot-stock-alert"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/logs"
OUT_LOG="$LOG_DIR/bot.log"
ERR_LOG="$LOG_DIR/bot.error.log"
UID_NUM="$(id -u)"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
  elif [ -x "/opt/homebrew/bin/node" ]; then
    echo "/opt/homebrew/bin/node"
  elif [ -x "/usr/local/bin/node" ]; then
    echo "/usr/local/bin/node"
  else
    echo "❌ Không tìm thấy Node.js!" >&2
    exit 1
  fi
}

stop_dev_if_running() {
  # Dừng nhẹ nếu còn tiến trình nest start:dev của chính project này để tránh 409 Conflict Telegram
  local pids
  pids="$(pgrep -f "$PROJECT_DIR/node_modules/.bin/nest|$PROJECT_DIR/dist/main" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "🛑 Đang dừng tiến trình local cũ ($pids) để tránh xung đột Telegram..."
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}

cmd_start() {
  local node_bin
  node_bin="$(find_node)"

  mkdir -p "$PLIST_DIR" "$LOG_DIR"

  echo "🔨 Đang build bản production..."
  (cd "$PROJECT_DIR" && npm run build)

  # Tắt service cũ nếu đang chạy
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  launchctl bootout "gui/$UID_NUM" "$PLIST_PATH" 2>/dev/null || true
  stop_dev_if_running

  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$PROJECT_DIR/dist/main.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>StandardOutPath</key>
  <string>$OUT_LOG</string>

  <key>StandardErrorPath</key>
  <string>$ERR_LOG</string>
</dict>
</plist>
EOF

  echo "🚀 Đang đăng ký & khởi chạy bot ngầm qua macOS LaunchAgent..."
  launchctl bootstrap "gui/$UID_NUM" "$PLIST_PATH"
  launchctl kickstart -k "gui/$UID_NUM/$LABEL" 2>/dev/null || true

  sleep 2
  cmd_status
  echo ""
  echo "📄 15 dòng log gần nhất ($OUT_LOG):"
  tail -n 15 "$OUT_LOG" 2>/dev/null || true
}

cmd_stop() {
  echo "🛑 Đang tắt bot chạy ngầm..."
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  launchctl bootout "gui/$UID_NUM" "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "✅ Đã tắt bot chạy ngầm và hủy tự khởi động cùng máy Mac."
}

cmd_status() {
  if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
    local pid state
    pid="$(launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null | awk '/pid =/{print $3; exit}')"
    state="$(launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null | awk '/state =/{print $3; exit}')"
    echo "✅ Bot ĐANG CHẠY NGẦM (state: ${state:-running}, PID: ${pid:-N/A})"
    echo "   Plist: $PLIST_PATH"
    echo "   Log:   $OUT_LOG"
  else
    echo "⚪ Bot hiện KHÔNG chạy ngầm."
  fi
}

cmd_logs() {
  mkdir -p "$LOG_DIR"
  touch "$OUT_LOG" "$ERR_LOG"
  echo "📡 Đang xem log realtime (nhấn Ctrl+C để thoát, bot vẫn chạy ngầm)..."
  tail -n 40 -f "$OUT_LOG" "$ERR_LOG"
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_start ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  *)
    echo "Cách dùng: bash scripts/bot-bg.sh {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
