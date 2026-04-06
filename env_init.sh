#!/usr/bin/env bash
if [ -f .env ]; then
  echo ".env already exists. Remove it first if you want to reinitialize."
  exit 1
fi

cp .env.example .env

# Generate random secrets using openssl
POSTGRES_PASSWORD=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)
JWT_SECRET=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 48)
PG_META_CRYPTO_KEY=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)
DASHBOARD_PASSWORD=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)

# Generate Supabase JWTs (HS256) signed with JWT_SECRET
GENERATE_JWTS_PY=$(cat << 'PYEOF'
import base64, hashlib, hmac, json, sys, time

def b64url(data):
    if isinstance(data, str):
        data = data.encode()
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()

def make_jwt(payload, secret):
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(',', ':')))
    body = b64url(json.dumps(payload, separators=(',', ':')))
    sig_input = f"{header}.{body}".encode()
    sig = hmac.new(secret.encode(), sig_input, hashlib.sha256).digest()
    return f"{header}.{body}.{b64url(sig)}"

secret = sys.argv[1]
now = int(time.time())
exp = now + 10 * 365 * 24 * 3600  # 10 years

anon = make_jwt({"role": "anon", "iss": "supabase", "iat": now, "exp": exp}, secret)
service = make_jwt({"role": "service_role", "iss": "supabase", "iat": now, "exp": exp}, secret)

print(anon)
print(service)
PYEOF
)

JWT_TOKENS=$(python3 -c "$GENERATE_JWTS_PY" "$JWT_SECRET")
ANON_KEY=$(echo "$JWT_TOKENS" | sed -n '1p')
SERVICE_ROLE_KEY=$(echo "$JWT_TOKENS" | sed -n '2p')

# Detect Local IP (works on macOS and Linux)
LOCAL_IP=$(ip -4 addr show eth0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n1)
if [ -z "$LOCAL_IP" ]; then
  LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null) # macOS en0
fi
if [ -z "$LOCAL_IP" ]; then
  LOCAL_IP=$(hostname -I | awk '{print $1}' 2>/dev/null) # Linux general
fi
LOCAL_IP="${LOCAL_IP:-127.0.0.1}"

echo "Detected Local IP: ${LOCAL_IP}"

# Helper: replace value of KEY=... in .env (handles special chars via | delimiter)
replace_env() {
  local key="$1"
  local value="$2"
  # Use | as delimiter to handle slashes in URLs
  sed -i.bak "s|^${key}=.*|${key}=${value}|" .env
}

replace_env POSTGRES_PASSWORD      "$POSTGRES_PASSWORD"
replace_env JWT_SECRET             "$JWT_SECRET"
replace_env PG_META_CRYPTO_KEY     "$PG_META_CRYPTO_KEY"
replace_env DASHBOARD_PASSWORD     "$DASHBOARD_PASSWORD"
replace_env ANON_KEY               "$ANON_KEY"
replace_env SERVICE_ROLE_KEY       "$SERVICE_ROLE_KEY"

# Networking Configuration for LAN Access
replace_env SUPABASE_PUBLIC_URL    "http://${LOCAL_IP}:8000"
replace_env VITE_SUPABASE_URL      "http://${LOCAL_IP}:8000"
replace_env VITE_SUPABASE_ANON_KEY "$ANON_KEY"

# Robot type selection
echo "Select robot type:"
echo "  1) SIMBOT    (simulator, default)"
echo "  2) FACOBOT   (external robot at 10.61.6.87)"
echo "  3) CUSTOM    (enter IP manually)"
read -rp "Enter choice [1/2/3]: " robot_choice

case "$robot_choice" in
  2)
    facobot_host="10.61.6.87"
    ROBOTS_CONFIG="{\"FACOBOT\": {\"host\": \"${facobot_host}\", \"port\": 9090, \"cell_heights\": [0.653, 1.073, 1.493, 1.913]}}"
    replace_env ROBOTS_CONFIG "'${ROBOTS_CONFIG}'"
    replace_env ROBOT_NAME "FACOBOT"
    replace_env ROBOT_HOST "${facobot_host}"
    sed -i.bak '/^  robot_simulator:/,/port:=9090/s/^/# /' docker-compose.yml && rm -f docker-compose.yml.bak
    echo "Robot: FACOBOT (${facobot_host})"
    ;;
  3)
    read -rp "Enter Robot host IP [${LOCAL_IP}]: " custom_host
    custom_host="${custom_host:-$LOCAL_IP}"
    ROBOTS_CONFIG="{\"CUSTOM_ROBOT\": {\"host\": \"${custom_host}\", \"port\": 9090, \"cell_heights\": [0.653, 1.073, 1.493, 1.913]}}"
    replace_env ROBOTS_CONFIG "'${ROBOTS_CONFIG}'"
    replace_env ROBOT_NAME "CUSTOM_ROBOT"
    replace_env ROBOT_HOST "${custom_host}"
    sed -i.bak '/^  robot_simulator:/,/port:=9090/s/^/# /' docker-compose.yml && rm -f docker-compose.yml.bak
    echo "Robot: CUSTOM_ROBOT (${custom_host})"
    ;;
  *)
    ROBOTS_CONFIG='{"SIMBOT": {"host": "robot_simulator", "port": 9090, "cell_heights": [0.653, 1.073, 1.493, 1.913]}}'
    replace_env ROBOTS_CONFIG "'${ROBOTS_CONFIG}'"
    replace_env ROBOT_NAME "SIMBOT"
    replace_env ROBOT_HOST "robot_simulator"
    echo "Robot: SIMBOT (simulator)"
    ;;
esac

# GraphQL IDE selection
echo ""
echo "Select GraphQL IDE:"
echo "  1) GraphiQL        (default)"
echo "  2) Apollo Sandbox"
echo "  3) GraphQL Playground"
read -rp "Enter choice [1/2/3]: " ide_choice

case "$ide_choice" in
  2) replace_env GRAPHQL_IDE "apollo-sandbox" ;;
  3) replace_env GRAPHQL_IDE "graphql-playground" ;;
  *)  replace_env GRAPHQL_IDE "graphiql" ;;
esac

rm -f .env.bak

echo ".env created with generated secrets."
echo
echo "  POSTGRES_PASSWORD  : ${POSTGRES_PASSWORD}"
echo "  JWT_SECRET         : ${JWT_SECRET}"
echo "  PG_META_CRYPTO_KEY : ${PG_META_CRYPTO_KEY}"
echo "  DASHBOARD_PASSWORD : ${DASHBOARD_PASSWORD}"
echo "  ANON_KEY           : ${ANON_KEY:0:40}..."
echo "  SERVICE_ROLE_KEY   : ${SERVICE_ROLE_KEY:0:40}..."
