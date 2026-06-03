#!/usr/bin/env bash
set -euo pipefail

env_file="${1:-.env.worker}"
config_file="wrangler.generated.jsonc"
worker_name="${WORKER_NAME:-spotify-discord-control}"

if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file. Copy .env.worker.example first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

worker_name="${WORKER_NAME:-$worker_name}"
kv_namespace_id="${KV_NAMESPACE_ID:-}"

required_vars=(
  PUBLIC_BASE_URL
  SPOTIFY_CLIENT_ID
  DISCORD_APPLICATION_ID
  DISCORD_PUBLIC_KEY
  DISCORD_BOT_TOKEN
  DISCORD_CHANNEL_ID
)
for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    echo "$var_name is required in $env_file." >&2
    exit 1
  fi
done

if [[ -z "$kv_namespace_id" ]]; then
  echo "Creating Cloudflare KV namespace SPOTIFY_TOKENS..."
  kv_output="$(bunx wrangler kv namespace create SPOTIFY_TOKENS 2>&1 || true)"
  kv_namespace_id="$(printf '%s' "$kv_output" | grep -Eo '[0-9a-f]{32}' | head -1 || true)"
fi

if [[ -z "$kv_namespace_id" ]]; then
  echo "Could not create KV namespace automatically." >&2
  echo "Wrangler output:" >&2
  printf '%s\n' "$kv_output" >&2
  echo "Set KV_NAMESPACE_ID in $env_file and run again." >&2
  exit 1
fi

if ! grep -q '^KV_NAMESPACE_ID=' "$env_file"; then
  printf '\nKV_NAMESPACE_ID=%s\n' "$kv_namespace_id" >> "$env_file"
fi

cat > "$config_file" <<JSON
{
  "\$schema": "node_modules/wrangler/config-schema.json",
  "name": "$worker_name",
  "main": "worker/src/index.ts",
  "compatibility_date": "2026-06-01",
  "kv_namespaces": [
    {
      "binding": "SPOTIFY_TOKENS",
      "id": "$kv_namespace_id"
    }
  ],
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  },
  "durable_objects": {
    "bindings": [
      {
        "name": "PLAYBACK_SYNC",
        "class_name": "PlaybackSyncDurableObject"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["PlaybackSyncDurableObject"]
    }
  ],
  "triggers": {
    "crons": ["* * * * *"]
  }
}
JSON

echo "Deploying $worker_name with $config_file..."
bunx wrangler deploy --config "$config_file" --secrets-file "$env_file"

echo "Registering Discord commands..."
bun run scripts/register-discord-commands.ts --env "$env_file"

cat <<EOF

Worker deploy complete.

Set this Discord Interactions Endpoint URL:
  ${PUBLIC_BASE_URL%/}/discord/interactions

Set this Spotify Redirect URI:
  ${SPOTIFY_REDIRECT_URI:-${PUBLIC_BASE_URL%/}${SPOTIFY_REDIRECT_PATH:-/spotify/callback}}
EOF
