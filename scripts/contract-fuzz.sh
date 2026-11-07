#!/usr/bin/env bash
# API-03: Schemathesis fuzz of a running Core against openapi.yaml (no 5xx, responses match the schema).
# Needs `supabase start`, a running Core at CORE_URL, and `st` on PATH. Writes fuzz data, so only point it at a throwaway database.
set -euo pipefail

CORE_URL="${CORE_URL:-http://localhost:5001}"
SUPABASE_URL=http://127.0.0.1:54321
SECRET=$(grep -E '^SUPABASE_SECRET_KEY=' .env.local | cut -d= -f2- | tr -d '\r')
PUBLISHABLE=sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH

auth_api() {
  curl -sf "$SUPABASE_URL$1" -H "apikey: $2" -H "Authorization: Bearer $2" -H "content-type: application/json" -d "$3"
}

# An admin, so the fuzz gets past authorization on every route. Tokens last 15 minutes, so each run gets its own.
new_token() {
  local email password user_id
  email="fuzz-$(date +%s%N)@example.com"
  password="fuzz-$(date +%s%N)-password"
  user_id=$(auth_api /auth/v1/admin/users "$SECRET" "{\"email\":\"$email\",\"password\":\"$password\",\"email_confirm\":true}" \
    | python -c "import json,sys;print(json.load(sys.stdin)['id'])")
  auth_api /rest/v1/user_roles "$SECRET" "{\"user_id\":\"$user_id\",\"role\":\"admin\"}" > /dev/null
  curl -sf "$SUPABASE_URL/auth/v1/token?grant_type=password" -H "apikey: $PUBLISHABLE" -H "content-type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}" \
    | python -c "import json,sys;print(json.load(sys.stdin)['access_token'])"
}

# Deleting the account would end the run. TRACE never reaches a route: Next answers it with a bare 500.
# 150/m keeps most calls under the per-minute budgets, so the routes run instead of answering 429.
for phases in coverage examples,fuzzing; do
  MSYS_NO_PATHCONV=1 PYTHONUTF8=1 PYTHONPATH=scripts SCHEMATHESIS_HOOKS=contract_fuzz_hooks timeout 840 \
    st run openapi/openapi.yaml --url "$CORE_URL" \
    -H "Authorization: Bearer $(new_token)" \
    --checks not_a_server_error,status_code_conformance,content_type_conformance,response_schema_conformance \
    --exclude-path /v1/me/account-deletion --exclude-method TRACE \
    --phases "$phases" --max-examples 10 --rate-limit 150/m --no-color "$@"
done
