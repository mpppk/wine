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
#   bash scripts/smoke.sh [BASE_URL] [--shared-db]
#   bun run smoke [BASE_URL]        # package.json 経由
# BASE_URL 省略時は本番 (https://wine.nibo.sh) を対象にする。
#
# --shared-db: 対象の D1 が PR プレビューと共有されている場合に付ける (wine-preview)。
#   /api/health の判定だけを緩める。詳細は check_health_shared_db の説明を参照。
#
# 全チェック成功で exit 0、1つでも失敗すると exit 1。
set -uo pipefail

BASE_URL=""
SHARED_DB=0
for arg in "$@"; do
  case "$arg" in
    --shared-db) SHARED_DB=1 ;;
    -*)
      echo "unknown option: $arg" >&2
      echo "usage: bash scripts/smoke.sh [BASE_URL] [--shared-db]" >&2
      exit 2
      ;;
    *) BASE_URL="$arg" ;;
  esac
done
BASE_URL="${BASE_URL:-https://wine.nibo.sh}"
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

# 共有 D1 (wine-preview-db) 向けの /api/health 判定 (#396)。
#
# プレビュー共通 DB には**開いている PR ブランチのマイグレーションが main より先に適用される**
# (docs/deployment.md「環境」)。つまり main ミラー (wine-preview) の
# `EXPECTED_LATEST_MIGRATION` より適用済みが進んでいる状態は**正常**で、ここで
# `"ok":true` を要求すると、誰かがスキーマ変更 PR を開いている間ずっとスモークが赤くなる
# (＝赤が常態化して誰も見なくなる)。
#
# そこで共有 DB の対象では、進んでいる分は許容しつつ次の2つは落とす:
#   - D1 に到達できない / クエリが失敗する (`"db":"error"`)。バインディング設定ミスや
#     共有 DB の破損 (#54) はここに出る
#   - 適用済みが期待より**戻っている** (applied < expected)。マイグレーションが当たらずに
#     新コードだけ載った状態で、本番で最も警戒している「新コード×旧スキーマ」に当たる
check_health_shared_db() {
  local url="${BASE_URL}/api/health"
  local body code applied expected applied_seq expected_seq
  # 不一致時の 503 は --retry の対象になり数秒余計にかかるが、一過性の 5xx と
  # 区別できないのでリトライ設定は本番と揃える。
  body="$(curl "${CURL_OPTS[@]}" -w '\n%{http_code}' -X GET "$url" 2>/dev/null)"
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"

  # 不一致時は 503 が返る (=共有 DB では想定内)。それ以外のコードは異常。
  if [ "$code" != "200" ] && [ "$code" != "503" ]; then
    printf '  FAIL  %-4s %-45s want=200/503 got=%s\n' GET /api/health "$code"
    fail=$((fail + 1))
    return
  fi
  if ! printf '%s' "$body" | grep -qF '"db":"ok"'; then
    printf '  FAIL  %-4s %-45s got=%s (expected %q)\n' GET /api/health "$code" '"db":"ok"'
    fail=$((fail + 1))
    return
  fi

  # {"migration":{"applied":"0027_foo","expected":"0027_foo",...}} から連番を取り出す。
  # applied は null になり得る (その場合 grep が空になり、下の数値判定で落ちる)。
  applied="$(printf '%s' "$body" | grep -o '"applied":"[^"]*"' | head -1 | sed 's/.*:"//; s/"$//')"
  expected="$(printf '%s' "$body" | grep -o '"expected":"[^"]*"' | head -1 | sed 's/.*:"//; s/"$//')"
  applied_seq="${applied%%_*}"
  expected_seq="${expected%%_*}"
  if ! printf '%s' "$applied_seq" | grep -qE '^[0-9]+$' ||
    ! printf '%s' "$expected_seq" | grep -qE '^[0-9]+$'; then
    printf '  FAIL  %-4s %-45s got=%s (migration 連番を読めない applied=%q expected=%q)\n' \
      GET /api/health "$code" "$applied" "$expected"
    fail=$((fail + 1))
    return
  fi
  # 先頭ゼロを8進数と解釈させないため 10# を付ける
  if [ "$((10#$applied_seq))" -lt "$((10#$expected_seq))" ]; then
    printf '  FAIL  %-4s %-45s got=%s (適用済みが期待より古い applied=%s expected=%s)\n' \
      GET /api/health "$code" "$applied" "$expected"
    fail=$((fail + 1))
    return
  fi

  local note="in sync"
  if [ "$((10#$applied_seq))" -gt "$((10#$expected_seq))" ]; then
    note="ahead (PR ブランチが先行適用。共有 DB では想定内)"
  fi
  printf '  ok    %-4s %-45s %s (db=ok applied=%s expected=%s / %s)\n' \
    GET /api/health "$code" "$applied" "$expected" "$note"
  pass=$((pass + 1))
}

echo "Smoke test against: ${BASE_URL}"
if [ "$SHARED_DB" -eq 1 ]; then
  echo "(shared-db profile: /api/health は先行適用を許容する)"
fi
echo

# --- HTML (SSR) ---
check_status GET / 200 "home page"

# --- D1 (DB接続 + マイグレーション適用状態) ---
# 唯一「未認証で D1 に SELECT が走る」チェック(#336)。ここが無いと、マイグレーションだけ
# 当たって新 Worker が反映されていない状態や D1 バインディングの設定ミスを、他のどの
# チェックも検出できない(ホームも OAuth メタデータも DB を引かずに 200 を返すため)。
# ズレ・接続失敗はどちらも 503 + "ok":false になる。
# 共有 D1 (プレビュー) だけは PR ブランチの先行適用を許容する (--shared-db)。
if [ "$SHARED_DB" -eq 1 ]; then
  check_health_shared_db
else
  check_body GET /api/health 200 '"ok":true'
fi

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
