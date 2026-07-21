#!/usr/bin/env bash
#
# デプロイ後のスモークテスト (Issue #53)。
#
# デプロイ済み Worker の主要エンドポイントを curl で叩き、HTTP ステータス
# (必要に応じてボディ/ヘッダ) を検証する。ランタイム挙動を一切検証しない
# unit CI を補い、「PR を跨いだ回帰」(better-auth 更新で OAuth が壊れる等) が
# 本番/プレビューに出てしまったことを検出する。
#
# 使い方:
#   bash scripts/smoke.sh [BASE_URL]
#   bun run smoke [BASE_URL]        # package.json 経由
# BASE_URL 省略時は本番 (https://wine.nibo.sh) を対象にする。
#
# 全チェック成功で exit 0、1つでも失敗すると exit 1。
set -uo pipefail

BASE_URL="${1:-https://wine.nibo.sh}"
BASE_URL="${BASE_URL%/}" # 末尾スラッシュを除去

# curl のリトライ設定 (外部サービスの一時的な揺らぎ対策)。
# --retry は 5xx/408/429 と接続失敗に対して指数バックオフで再試行する。
CURL_OPTS=(--silent --show-error --location --max-time 20 --retry 3 --retry-delay 2 --retry-connrefused)

pass=0
fail=0

# ステータスコード検証。
#   check_status <method> <path> <expected_code> [description]
check_status() {
  local method="$1" path="$2" want="$3" desc="${4:-}"
  local url="${BASE_URL}${path}"
  local got
  got="$(curl "${CURL_OPTS[@]}" -o /dev/null -w '%{http_code}' -X "$method" "$url" 2>/dev/null)"
  if [ "$got" = "$want" ]; then
    printf '  ok    %-4s %-45s %s\n' "$method" "$path" "$got"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-4s %-45s want=%s got=%s %s\n' "$method" "$path" "$want" "$got" "$desc"
    fail=$((fail + 1))
  fi
}

# ステータス + ボディに部分文字列が含まれることを検証。
#   check_body <method> <path> <expected_code> <substring>
check_body() {
  local method="$1" path="$2" want="$3" needle="$4"
  local url="${BASE_URL}${path}"
  local body code
  # ボディを取りつつ末尾にステータスコードを付与する
  body="$(curl "${CURL_OPTS[@]}" -w '\n%{http_code}' -X "$method" "$url" 2>/dev/null)"
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [ "$code" = "$want" ] && printf '%s' "$body" | grep -qF "$needle"; then
    printf '  ok    %-4s %-45s %s (contains %q)\n' "$method" "$path" "$code" "$needle"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-4s %-45s want=%s got=%s (expected body contains %q)\n' \
      "$method" "$path" "$want" "$code" "$needle"
    fail=$((fail + 1))
  fi
}

# ステータス + 指定ヘッダが存在する (任意で値の部分一致) ことを検証。
#   check_header <method> <path> <expected_code> <header-name> [header-substring]
check_header() {
  local method="$1" path="$2" want="$3" header="$4" needle="${5:-}"
  local url="${BASE_URL}${path}"
  local headers code
  headers="$(curl "${CURL_OPTS[@]}" -D - -o /dev/null -w '%{http_code}' -X "$method" "$url" 2>/dev/null)"
  code="${headers##*$'\n'}"
  # ヘッダ名は大文字小文字を無視して検索する
  if [ "$code" = "$want" ] && printf '%s' "$headers" | grep -iq "^${header}:"; then
    if [ -z "$needle" ] || printf '%s' "$headers" | grep -iF "$needle" >/dev/null; then
      printf '  ok    %-4s %-45s %s (%s)\n' "$method" "$path" "$code" "$header"
      pass=$((pass + 1))
      return
    fi
  fi
  printf '  FAIL  %-4s %-45s want=%s got=%s (expected header %s %s)\n' \
    "$method" "$path" "$want" "$code" "$header" "$needle"
  fail=$((fail + 1))
}

# 非空ボディ + ステータスを検証 (GeoJSON 静的配信用)。
#   check_nonempty <method> <path> <expected_code>
check_nonempty() {
  local method="$1" path="$2" want="$3"
  local url="${BASE_URL}${path}"
  local size code
  size="$(curl "${CURL_OPTS[@]}" -o /dev/null -w '%{size_download} %{http_code}' -X "$method" "$url" 2>/dev/null)"
  code="${size##* }"
  size="${size%% *}"
  if [ "$code" = "$want" ] && [ "${size:-0}" -gt 0 ]; then
    printf '  ok    %-4s %-45s %s (%s bytes)\n' "$method" "$path" "$code" "$size"
    pass=$((pass + 1))
  else
    printf '  FAIL  %-4s %-45s want=%s got=%s (%s bytes)\n' "$method" "$path" "$want" "$code" "${size:-0}"
    fail=$((fail + 1))
  fi
}

echo "Smoke test against: ${BASE_URL}"
echo

# --- HTML (SSR) ---
check_status GET / 200 "home page"

# --- better-auth ---
# /api/auth/ok は better-auth 組込みのヘルスチェック相当 (未認証で 200 {"ok":true})。
check_body   GET /api/auth/ok 200 '"ok":true'
# 未認証セッション取得は 200 を返す (回帰でここが 500 等になると検出できる)。
check_status GET /api/auth/get-session 200 "unauthenticated session"

# --- OAuth ディスカバリ (.well-known, サイトルート直下) ---
check_status GET /.well-known/oauth-authorization-server 200 "RFC 8414 metadata"
check_status GET /.well-known/oauth-protected-resource 200 "RFC 9728 metadata"

# --- MCP エンドポイント ---
# トークン無し POST は 401 + WWW-Authenticate (保護リソースメタデータを指す) を返す。
check_header POST /api/mcp 401 WWW-Authenticate
# GET/DELETE は 405 (Allow: POST)。
check_header GET  /api/mcp 405 Allow POST

# --- GeoJSON 静的配信 ---
# content-type は Cloudflare のアセット MIME に依存するため厳密検証せず、
# 200 + 非空ボディのみ確認する。
check_nonempty GET /data/aop/bordeaux.geojson 200

echo
echo "Result: ${pass} passed, ${fail} failed"
if [ "$fail" -ne 0 ]; then
  exit 1
fi
