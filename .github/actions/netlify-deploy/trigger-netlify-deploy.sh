#!/usr/bin/env bash
# Netlify Build Hook を bounded retry 付きで POST する。
#
# 設計原則（変更禁止の安全条件）:
#   - retry するのは「一過性の通信失敗」と「Netlify 側の一時的な過負荷」だけ:
#       curl exit 6 / 7 / 28 / 35 / 52 / 55 / 56、HTTP 429、HTTP 5xx
#   - HTTP 4xx（hook URL 誤り・失効などの設定不良）と未知エラーは retry せず即 FAIL
#   - retry 上限（既定 3 回）到達後は FAIL。無制限 retry は禁止
#   - hook URL / API token / response 本文はログへ出さない
#   - 同一 commit の重複 build を避けるため、可能なら Netlify API で deploy 有無を確認する
#
# 入力はすべて環境変数（action.yml が渡す）。値そのものはログに出さない。

set -uo pipefail

HOOK="${NETLIFY_BUILD_HOOK:-}"
REASON="${DEPLOY_REASON:-auto-import}"
COMMIT_SHA="${DEPLOY_COMMIT_SHA:-}"
API_TOKEN="${NETLIFY_API_TOKEN:-}"
SITE_ID="${NETLIFY_SITE_ID:-}"
API_BASE="${NETLIFY_API_BASE:-https://api.netlify.com/api/v1}"
REQUIRE_HOOK="${REQUIRE_HOOK:-false}"
MAX_ATTEMPTS_RAW="${MAX_ATTEMPTS:-3}"
BACKOFF_SECONDS="${BACKOFF_SECONDS:-5 15 30}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-30}"
MAX_TIME="${MAX_TIME:-90}"

# ---- 上限のクランプ（無制限 retry 禁止）----
case "$MAX_ATTEMPTS_RAW" in
  ''|*[!0-9]*) MAX_ATTEMPTS=3 ;;
  *) MAX_ATTEMPTS="$MAX_ATTEMPTS_RAW" ;;
esac
[ "$MAX_ATTEMPTS" -lt 1 ] && MAX_ATTEMPTS=1
[ "$MAX_ATTEMPTS" -gt 5 ] && MAX_ATTEMPTS=5

BACKOFF=($BACKOFF_SECONDS)

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
RESP_BODY="$WORK_DIR/resp"
CURL_ERR="$WORK_DIR/curl_err"
API_BODY="$WORK_DIR/api"

START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SHORT_SHA=""
if [ -n "$COMMIT_SHA" ]; then
  SHORT_SHA="$(printf '%s' "$COMMIT_SHA" | cut -c1-7)"
fi

log() { printf '%s\n' "$*"; }

# ---- hook 未設定 ----
if [ -z "$HOOK" ]; then
  if [ "$REQUIRE_HOOK" = "true" ]; then
    log "❌ NETLIFY_BUILD_HOOK が未設定です（require-hook: true のため FAIL）"
    log "   → retry 対象外の設定不良として即座に失敗させています。"
    exit 1
  fi
  log "⏭️  NETLIFY_BUILD_HOOK が未設定のためデプロイトリガーをスキップ（no-op）"
  log "    → 自動デプロイを有効化するには Netlify Build Hook を作成し、"
  log "       GitHub secret 'NETLIFY_BUILD_HOOK' に登録してください。"
  exit 0
fi

# ---- deploy 有無の確認が可能か ----
deploy_check_enabled() {
  [ -n "$API_TOKEN" ] || return 1
  [ -n "$SITE_ID" ] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  return 0
}

# 既存 deploy 件数を stdout に返す。API 到達不能・解析不能なら -1（＝判定不能）。
#   - COMMIT_SHA 指定時: その commit の deploy（失敗/スキップ状態は除く）
#   - COMMIT_SHA 未指定時: 本 action 開始時刻以降に作成された production deploy
count_existing_deploys() {
  local code
  code="$(curl -sS -o "$API_BODY" -w '%{http_code}' \
    --connect-timeout 15 --max-time 30 \
    -H "Authorization: Bearer ${API_TOKEN}" \
    "${API_BASE}/sites/${SITE_ID}/deploys?per_page=20" 2>/dev/null)"
  if [ $? -ne 0 ]; then
    printf '%s' "-1"; return 0
  fi
  case "$code" in
    2*) ;;
    *) printf '%s' "-1"; return 0 ;;
  esac
  local n
  n="$(jq -r --arg sha "$SHORT_SHA" --arg since "$START_TS" '
        [ .[]
          | select(((.state // "") != "error") and ((.state // "") != "rejected"))
          | select(
              if $sha != "" then ((.commit_ref // "") | .[0:7]) == $sha
              else ((.context // "") == "production") and ((.created_at // "") >= $since)
              end
            )
        ] | length' "$API_BODY" 2>/dev/null)"
  case "$n" in
    ''|*[!0-9]*) printf '%s' "-1" ;;
    *) printf '%s' "$n" ;;
  esac
}

retryable_curl_exit() {
  case "$1" in
    6|7|28|35|52|55|56) return 0 ;;  # DNS / 接続 / timeout / SSL / 空応答 / 送受信失敗
    *) return 1 ;;
  esac
}

retryable_http() {
  case "$1" in
    429) return 0 ;;
    5??) return 0 ;;
    *) return 1 ;;
  esac
}

log "🚀 Netlify デプロイをトリガー: ${REASON}"
[ -n "$SHORT_SHA" ] && log "   対象 commit: ${SHORT_SHA}"
log "   retry 上限: ${MAX_ATTEMPTS} 回 / connect-timeout ${CONNECT_TIMEOUT}s / max-time ${MAX_TIME}s"
if deploy_check_enabled; then
  log "   deploy 重複チェック: 有効（Netlify API）"
else
  log "   deploy 重複チェック: 無効（NETLIFY_AUTH_TOKEN / site-id / jq のいずれか不足）"
fi

# ---- 事前チェック: 対象 commit の deploy が既にあるなら POST しない ----
if [ -n "$COMMIT_SHA" ] && deploy_check_enabled; then
  PRE="$(count_existing_deploys)"
  if [ "$PRE" != "-1" ] && [ "$PRE" -gt 0 ]; then
    log "✅ commit ${SHORT_SHA} の deploy が既に存在します（${PRE} 件）。重複 build を避けるため POST しません。"
    exit 0
  fi
fi

ATTEMPT=1
while :; do
  # 2 回目以降は「前回の POST が届いていた可能性」を先に確認する。
  # 応答だけ失った場合に同じ build を二重起動しないため。
  if [ "$ATTEMPT" -gt 1 ] && deploy_check_enabled; then
    FOUND="$(count_existing_deploys)"
    if [ "$FOUND" != "-1" ] && [ "$FOUND" -gt 0 ]; then
      log "✅ 直前の POST は Netlify に到達していました（deploy ${FOUND} 件を検出）。再送しません。"
      exit 0
    fi
  fi

  log "📡 build hook POST (attempt ${ATTEMPT}/${MAX_ATTEMPTS})"
  HTTP="$(curl -sS -o "$RESP_BODY" -w '%{http_code}' \
    --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
    -X POST -H 'Content-Type: application/json' -d '{}' \
    "$HOOK" 2>"$CURL_ERR")"
  RC=$?

  if [ "$RC" -ne 0 ]; then
    # curl のエラー本文は出さない（URL が含まれうるため）。分類に必要な exit code だけ記録する。
    log "   ⚠️  通信失敗: curl exit ${RC}（HTTP ${HTTP:-000}）"
    if retryable_curl_exit "$RC" && [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; then
      IDX=$((ATTEMPT - 1))
      SLEEP_FOR="${BACKOFF[$IDX]:-30}"
      log "   ⏳ 一過性の通信失敗として ${SLEEP_FOR}s 後に再試行します"
      sleep "$SLEEP_FOR"
      ATTEMPT=$((ATTEMPT + 1))
      continue
    fi
    if retryable_curl_exit "$RC"; then
      log "❌ retry 上限（${MAX_ATTEMPTS} 回）に到達しました。Netlify ビルドは起動していません。"
    else
      log "❌ retry 対象外の通信エラー（curl exit ${RC}）のため中止します。"
    fi
    exit 1
  fi

  case "$HTTP" in
    2*)
      log "✅ Netlify ビルドを起動しました（HTTP ${HTTP} / 数分後に本番反映）"
      exit 0
      ;;
    *)
      if retryable_http "$HTTP" && [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; then
        IDX=$((ATTEMPT - 1))
        SLEEP_FOR="${BACKOFF[$IDX]:-30}"
        log "   ⚠️  一時的な失敗 (HTTP ${HTTP})。${SLEEP_FOR}s 後に再試行します"
        sleep "$SLEEP_FOR"
        ATTEMPT=$((ATTEMPT + 1))
        continue
      fi
      if retryable_http "$HTTP"; then
        log "❌ retry 上限（${MAX_ATTEMPTS} 回）に到達しました (HTTP ${HTTP})。Netlify ビルドは起動していません。"
      else
        log "❌ Netlify ビルド起動に失敗 (HTTP ${HTTP})。設定不良の可能性があるため retry しません。"
        log "   → build hook URL の有効性を確認してください（URL 値はログに出しません）。"
      fi
      exit 1
      ;;
  esac
done
