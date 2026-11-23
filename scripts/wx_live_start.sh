#!/bin/bash
# 近リアルタイム気象ポラーをバックグラウンドで起動する。
# 通常の Python + Node プロセスで、モデルや LLM は呼ばない。
# ボックスが入れ替わったら、リポジトリを pull したうえでこのスクリプトを再実行する。
# Cloudflare のトークンはチャットに書かず、600 の env ファイルから読む。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${FB_CLOUDFLARE_ENV:-/workspace/fb-secrets/cloudflare.env}"
LOG="${FB_WX_LIVE_LOG:-/workspace/fb-work/wx-live.log}"
PIDFILE="${FB_WX_LIVE_PID:-/workspace/fb-work/wx-live.pid}"
mkdir -p "$(dirname "$LOG")" "$(dirname "$PIDFILE")"

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running pid=$(cat "$PIDFILE")"
  exit 0
fi
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" || -z "${CLOUDFLARE_KV_NAMESPACE_ID:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_KV_NAMESPACE_ID が未設定です。"
  echo "（$ENV_FILE に書く。chmod 600。チャットには貼らない）"
  echo "--local だけなら: python3 $ROOT/scripts/wx_live_poller.py --loop --local"
  exit 1
fi
PYTHONUNBUFFERED=1 nohup python3 "$ROOT/scripts/wx_live_poller.py" --loop >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"
echo "started pid=$! log=$LOG"
