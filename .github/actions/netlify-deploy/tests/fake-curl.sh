#!/usr/bin/env bash
# テスト用の curl スタブ。実ネットワークへは一切出ない。
#
# 制御用 env:
#   SHIM_STATE        状態ディレクトリ（POST 回数・シナリオ・API 応答を置く）
#   $SHIM_STATE/scenario     1 行 1 試行。100 未満 = curl exit code、100 以上 = HTTP status
#   $SHIM_STATE/api_initial.json      API GET の初期応答（省略時は空配列）
#   $SHIM_STATE/api_after_post.json   POST が 1 回以上行われた後の API GET 応答（任意）
#   $SHIM_STATE/post_count            POST 回数（本スタブが加算）
#   $SHIM_STATE/api_count             API GET 回数（本スタブが加算）
#   $SHIM_STATE/urls                  受け取った URL の記録（秘匿漏れ検査用ではなく呼び出し検査用）

set -u

STATE="${SHIM_STATE:?SHIM_STATE required}"
OUT_FILE=""
IS_POST=0
URL=""
prev=""

for arg in "$@"; do
  case "$prev" in
    -o) OUT_FILE="$arg" ;;
  esac
  case "$arg" in
    POST) [ "$prev" = "-X" ] && IS_POST=1 ;;
    http://*|https://*) URL="$arg" ;;
  esac
  prev="$arg"
done

printf '%s\n' "$URL" >> "$STATE/urls"

read_count() { [ -f "$1" ] && cat "$1" || printf '0'; }

if [ "$IS_POST" = "1" ]; then
  N=$(read_count "$STATE/post_count")
  N=$((N + 1))
  printf '%s' "$N" > "$STATE/post_count"

  LINE="$(sed -n "${N}p" "$STATE/scenario" 2>/dev/null)"
  [ -z "$LINE" ] && LINE="200"

  if [ "$LINE" -lt 100 ]; then
    # 通信失敗: curl は http_code に 000 を出し、非ゼロで終了する
    printf '000'
    printf 'curl: (%s) simulated transport failure for %s\n' "$LINE" "$URL" >&2
    exit "$LINE"
  fi

  [ -n "$OUT_FILE" ] && printf '{"ok":true}' > "$OUT_FILE"
  printf '%s' "$LINE"
  exit 0
fi

# --- API GET ---
A=$(read_count "$STATE/api_count")
A=$((A + 1))
printf '%s' "$A" > "$STATE/api_count"

POSTS=$(read_count "$STATE/post_count")
SRC="$STATE/api_initial.json"
if [ "$POSTS" -ge 1 ] && [ -f "$STATE/api_after_post.json" ]; then
  SRC="$STATE/api_after_post.json"
fi

if [ -f "$SRC" ]; then
  [ -n "$OUT_FILE" ] && cat "$SRC" > "$OUT_FILE"
else
  [ -n "$OUT_FILE" ] && printf '[]' > "$OUT_FILE"
fi
printf '200'
exit 0
