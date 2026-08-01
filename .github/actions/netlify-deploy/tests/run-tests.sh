#!/usr/bin/env bash
# trigger-netlify-deploy.sh のユニットテスト。
# 実ネットワーク・実 Netlify へは一切アクセスしない（curl はスタブへ差し替える）。
#
#   bash .github/actions/netlify-deploy/tests/run-tests.sh

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../trigger-netlify-deploy.sh"

PASS=0
FAIL=0

# ログに出てはいけない秘匿値
SECRET_HOOK_ID="SUPERSECRETHOOKID12345"
SECRET_TOKEN="SUPERSECRETNETLIFYTOKEN"
HOOK_URL="https://api.netlify.com/build_hooks/${SECRET_HOOK_ID}"

ok() { PASS=$((PASS + 1)); printf '  ✅ %s\n' "$1"; }
ng() { FAIL=$((FAIL + 1)); printf '  ❌ %s\n' "$1"; }

assert_eq() {
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else ng "$1 (expected: $3 / actual: $2)"; fi
}

assert_not_contains() {
  # $1=label $2=haystack-file $3=needle
  if grep -q "$3" "$2" 2>/dev/null; then ng "$1 (秘匿値がログに出力された)"; else ok "$1"; fi
}

# run_case <name> <scenario-lines> [env assignments...]
# 実行結果を EXIT_CODE / POST_COUNT / LOG_FILE に入れる
run_case() {
  CASE_NAME="$1"; shift
  SCENARIO="$1"; shift

  STATE="$(mktemp -d)"
  BIN="$STATE/bin"
  mkdir -p "$BIN"
  cp "$HERE/fake-curl.sh" "$BIN/curl"
  chmod +x "$BIN/curl"
  printf '%s\n' "$SCENARIO" > "$STATE/scenario"
  LOG_FILE="$STATE/log"

  printf '\n▶ %s\n' "$CASE_NAME"

  env PATH="$BIN:$PATH" SHIM_STATE="$STATE" \
      BACKOFF_SECONDS="0 0 0" \
      NETLIFY_API_BASE="https://api.netlify.com/api/v1" \
      "$@" \
      bash "$SCRIPT" > "$LOG_FILE" 2>&1
  EXIT_CODE=$?
  POST_COUNT="$(cat "$STATE/post_count" 2>/dev/null || printf '0')"
  STATE_DIR="$STATE"
}

# 対象 commit の deploy が存在する API 応答
deploy_json() {
  cat <<'JSON'
[
  {"id":"dep1","state":"ready","context":"production","commit_ref":"7672c4a159e3306fd9ff392ce4726953ccfb6f55","created_at":"2099-01-01T00:00:00.000Z"}
]
JSON
}

printf '=== trigger-netlify-deploy.sh tests ===\n'

# --- 1. 初回 timeout → deploy 未作成 → 2 回目成功 ---
run_case "1. 初回 timeout(28) → 2 回目 200 で成功" "28
200" NETLIFY_BUILD_HOOK="$HOOK_URL"
assert_eq "exit code" "$EXIT_CODE" "0"
assert_eq "POST 回数" "$POST_COUNT" "2"

# --- 2. 初回 timeout だが Netlify 側では deploy 作成済み → 再 POST しない ---
run_case_2() {
  STATE="$(mktemp -d)"; BIN="$STATE/bin"; mkdir -p "$BIN"
  cp "$HERE/fake-curl.sh" "$BIN/curl"; chmod +x "$BIN/curl"
  printf '28\n200\n' > "$STATE/scenario"
  printf '[]' > "$STATE/api_initial.json"
  deploy_json > "$STATE/api_after_post.json"
  LOG_FILE="$STATE/log"
  printf '\n▶ %s\n' "2. 初回 timeout・Netlify 側は deploy 作成済み → 再 POST なし"
  env PATH="$BIN:$PATH" SHIM_STATE="$STATE" BACKOFF_SECONDS="0 0 0" \
      NETLIFY_BUILD_HOOK="$HOOK_URL" \
      NETLIFY_API_TOKEN="$SECRET_TOKEN" NETLIFY_SITE_ID="site-123" \
      DEPLOY_COMMIT_SHA="7672c4a159e3306fd9ff392ce4726953ccfb6f55" \
      bash "$SCRIPT" > "$LOG_FILE" 2>&1
  EXIT_CODE=$?
  POST_COUNT="$(cat "$STATE/post_count" 2>/dev/null || printf '0')"
  STATE_DIR="$STATE"
}
run_case_2
assert_eq "exit code" "$EXIT_CODE" "0"
assert_eq "POST 回数（重複 build を起こさない）" "$POST_COUNT" "1"
if grep -q "再送しません" "$LOG_FILE"; then ok "再送抑止のログあり"; else ng "再送抑止のログなし"; fi

# --- 3. 429 → retry 後成功 ---
run_case "3. HTTP 429 → retry 後成功" "429
200" NETLIFY_BUILD_HOOK="$HOOK_URL"
assert_eq "exit code" "$EXIT_CODE" "0"
assert_eq "POST 回数" "$POST_COUNT" "2"

# --- 4. 503 → retry 後成功 ---
run_case "4. HTTP 503 → retry 後成功" "503
200" NETLIFY_BUILD_HOOK="$HOOK_URL"
assert_eq "exit code" "$EXIT_CODE" "0"
assert_eq "POST 回数" "$POST_COUNT" "2"

# --- 5. 401 / 403 → retry せず即 FAIL ---
run_case "5a. HTTP 401 → retry せず FAIL" "401
200" NETLIFY_BUILD_HOOK="$HOOK_URL"
assert_eq "exit code" "$EXIT_CODE" "1"
assert_eq "POST 回数（retry しない）" "$POST_COUNT" "1"

run_case "5b. HTTP 403 → retry せず FAIL" "403
200" NETLIFY_BUILD_HOOK="$HOOK_URL"
assert_eq "exit code" "$EXIT_CODE" "1"
assert_eq "POST 回数（retry しない）" "$POST_COUNT" "1"

run_case "5c. HTTP 404 → retry せず FAIL" "404
200" NETLIFY_BUILD_HOOK="$HOOK_URL"
assert_eq "exit code" "$EXIT_CODE" "1"
assert_eq "POST 回数（retry しない）" "$POST_COUNT" "1"

# --- 6. retry 上限到達 → FAIL ---
run_case "6. timeout が続き retry 上限 → FAIL" "28
28
28
200" NETLIFY_BUILD_HOOK="$HOOK_URL"
assert_eq "exit code" "$EXIT_CODE" "1"
assert_eq "POST 回数（上限 3 で停止）" "$POST_COUNT" "3"
if grep -q "retry 上限" "$LOG_FILE"; then ok "上限到達のログあり"; else ng "上限到達のログなし"; fi

# --- 7. hook 未設定 ---
run_case "7a. hook 未設定（既定）→ no-op で成功・POST しない" "200" NETLIFY_BUILD_HOOK=""
assert_eq "exit code" "$EXIT_CODE" "0"
assert_eq "POST 回数" "$POST_COUNT" "0"

run_case "7b. hook 未設定 + require-hook=true → 即 FAIL・POST しない" "200" \
  NETLIFY_BUILD_HOOK="" REQUIRE_HOOK="true"
assert_eq "exit code" "$EXIT_CODE" "1"
assert_eq "POST 回数" "$POST_COUNT" "0"

# --- 8. 秘匿値がログに出ない ---
run_case "8. 秘匿値（hook URL / token）がログに出ない" "28
401" NETLIFY_BUILD_HOOK="$HOOK_URL" NETLIFY_API_TOKEN="$SECRET_TOKEN" NETLIFY_SITE_ID="site-123"
assert_not_contains "hook URL がログに無い" "$LOG_FILE" "$SECRET_HOOK_ID"
assert_not_contains "API token がログに無い" "$LOG_FILE" "$SECRET_TOKEN"
assert_not_contains "response 本文がログに無い" "$LOG_FILE" '{"ok":true}'

# --- 9. 正常時は 1 回だけ POST ---
run_case "9. 正常時は POST 1 回のみ" "200" NETLIFY_BUILD_HOOK="$HOOK_URL"
assert_eq "exit code" "$EXIT_CODE" "0"
assert_eq "POST 回数" "$POST_COUNT" "1"

# --- 10. commit-sha 指定 + 既に deploy 済み → POST 0 回 ---
run_case_10() {
  STATE="$(mktemp -d)"; BIN="$STATE/bin"; mkdir -p "$BIN"
  cp "$HERE/fake-curl.sh" "$BIN/curl"; chmod +x "$BIN/curl"
  printf '200\n' > "$STATE/scenario"
  deploy_json > "$STATE/api_initial.json"
  LOG_FILE="$STATE/log"
  printf '\n▶ %s\n' "10. commit の deploy が既存 → POST を送らない"
  env PATH="$BIN:$PATH" SHIM_STATE="$STATE" BACKOFF_SECONDS="0 0 0" \
      NETLIFY_BUILD_HOOK="$HOOK_URL" \
      NETLIFY_API_TOKEN="$SECRET_TOKEN" NETLIFY_SITE_ID="site-123" \
      DEPLOY_COMMIT_SHA="7672c4a159e3306fd9ff392ce4726953ccfb6f55" \
      bash "$SCRIPT" > "$LOG_FILE" 2>&1
  EXIT_CODE=$?
  POST_COUNT="$(cat "$STATE/post_count" 2>/dev/null || printf '0')"
}
run_case_10
assert_eq "exit code" "$EXIT_CODE" "0"
assert_eq "POST 回数（事前 dedup）" "$POST_COUNT" "0"

# --- 11. self-heal 用途: commit-sha 未指定なら既存 deploy があっても POST する ---
run_case_11() {
  STATE="$(mktemp -d)"; BIN="$STATE/bin"; mkdir -p "$BIN"
  cp "$HERE/fake-curl.sh" "$BIN/curl"; chmod +x "$BIN/curl"
  printf '200\n' > "$STATE/scenario"
  deploy_json > "$STATE/api_initial.json"
  LOG_FILE="$STATE/log"
  printf '\n▶ %s\n' "11. commit-sha 未指定（self-heal）は既存 deploy があっても POST する"
  env PATH="$BIN:$PATH" SHIM_STATE="$STATE" BACKOFF_SECONDS="0 0 0" \
      NETLIFY_BUILD_HOOK="$HOOK_URL" \
      NETLIFY_API_TOKEN="$SECRET_TOKEN" NETLIFY_SITE_ID="site-123" \
      bash "$SCRIPT" > "$LOG_FILE" 2>&1
  EXIT_CODE=$?
  POST_COUNT="$(cat "$STATE/post_count" 2>/dev/null || printf '0')"
}
run_case_11
assert_eq "exit code" "$EXIT_CODE" "0"
assert_eq "POST 回数" "$POST_COUNT" "1"

# --- 12. API 到達不能でも retry 自体は機能する（判定不能 = 送信を止めない） ---
run_case "12. deploy チェック無効（token なし）でも timeout を retry で吸収" "28
28
200" NETLIFY_BUILD_HOOK="$HOOK_URL"
assert_eq "exit code" "$EXIT_CODE" "0"
assert_eq "POST 回数" "$POST_COUNT" "3"

printf '\n=== 結果: %s passed / %s failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
