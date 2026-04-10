#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/.pid"
LOG_FILE="$DIR/server.log"
PORT="${STATUS_PORT:-60601}"
SERVICE_NAME="openclaw-status"

usage() {
  echo "Usage: $0 {start|stop|restart|status|logs|install|uninstall}"
  echo ""
  echo "Commands:"
  echo "  start      Start the dashboard server"
  echo "  stop       Stop the dashboard server"
  echo "  restart    Restart the dashboard server"
  echo "  status     Show server status"
  echo "  logs       Tail the log file"
  echo "  install    Install as systemd service (requires root)"
  echo "  uninstall  Remove systemd service"
  exit 1
}

is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

do_start() {
  if is_running; then
    echo "⚠️  Already running (PID $(cat "$PID_FILE"))"
    return 0
  fi
  # Auto-install deps if missing
  if [ ! -d "$DIR/node_modules/ws" ]; then
    echo "📦 Installing dependencies..."
    (cd "$DIR" && npm install --production 2>&1) >> "$LOG_FILE" 2>&1
    echo "✅ Dependencies installed"
  fi
  echo "🚀 Starting OpenClaw Status Dashboard on port $PORT..."
  nohup node "$DIR/server.js" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    echo "✅ Running (PID $pid)"
    echo "📊 http://localhost:$PORT"
  else
    echo "❌ Failed to start. Check $LOG_FILE"
    rm -f "$PID_FILE"
    return 1
  fi
}

do_stop() {
  # Stop systemd service if installed
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "🛑 Stopping systemd service..."
    systemctl stop "$SERVICE_NAME"
    echo "✅ Stopped"
    return 0
  fi

  if ! is_running; then
    echo "ℹ️  Not running"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid=$(cat "$PID_FILE")
  echo "🛑 Stopping (PID $pid)..."
  kill "$pid" 2>/dev/null || true
  # Wait for graceful shutdown
  for i in $(seq 1 10); do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "⚡ Force killing..."
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "✅ Stopped"
}

do_restart() {
  do_stop
  sleep 1
  do_start
}

do_status() {
  # Check systemd first
  if systemctl is-enabled "$SERVICE_NAME" 2>/dev/null; then
    echo "📋 Systemd service: $(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo 'unknown')"
    systemctl status "$SERVICE_NAME" --no-pager 2>/dev/null || true
    return 0
  fi

  if is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    echo "✅ Running (PID $pid)"
    echo "📊 http://localhost:$PORT"
    echo "📝 Log: $LOG_FILE"
    # Show memory usage
    if command -v ps &>/dev/null; then
      echo ""
      ps -p "$pid" -o pid,rss,vsz,pcpu,etime --no-headers 2>/dev/null | \
        awk '{printf "   PID: %s  RSS: %.1fMB  CPU: %s%%  Uptime: %s\n", $1, $2/1024, $4, $5}'
    fi
  else
    echo "⏹  Not running"
  fi
}

do_logs() {
  if [ -f "$LOG_FILE" ]; then
    tail -f "$LOG_FILE"
  else
    echo "No log file yet"
  fi
}

do_install() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "❌ install requires root. Run: sudo $0 install"
    exit 1
  fi

  local node_path
  node_path=$(which node)

  cat > /etc/systemd/system/"$SERVICE_NAME".service << EOF
[Unit]
Description=OpenClaw Status Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$node_path $DIR/server.js
Restart=on-failure
RestartSec=5
Environment=STATUS_PORT=$PORT
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE

[Install]
WantedBy=multi-user.target
EOF

  # Stop standalone instance if running
  if is_running; then
    do_stop
  fi

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl start "$SERVICE_NAME"
  echo "✅ Installed and started as systemd service"
  echo "📊 http://localhost:$PORT"
  echo "🔧 systemctl {start|stop|restart|status} $SERVICE_NAME"
}

do_uninstall() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "❌ uninstall requires root. Run: sudo $0 uninstall"
    exit 1
  fi

  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f /etc/systemd/system/"$SERVICE_NAME".service
  systemctl daemon-reload
  echo "✅ Uninstalled systemd service"
}

case "${1:-}" in
  start)     do_start ;;
  stop)      do_stop ;;
  restart)   do_restart ;;
  status)    do_status ;;
  logs)      do_logs ;;
  install)   do_install ;;
  uninstall) do_uninstall ;;
  *)         usage ;;
esac
