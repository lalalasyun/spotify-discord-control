#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${SPOTIFY_OAUTH_ENV_FILE:-$ROOT/.env}"
LOGIN=0

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap-oss.sh [--login]

Loads .env (or the current Doppler/exported environment), installs npm metadata,
and writes Spotify OAuth config.

Required variables:
  SPOTIFY_CLIENT_ID
  SPOTIFY_REDIRECT_URI

Optional:
  SPOTIFY_CLIENT_SECRET
  SPOTIFY_OAUTH_CONFIG_DIR

Examples:
  cp .env.example .env
  scripts/bootstrap-oss.sh --login

  doppler run -- scripts/bootstrap-oss.sh --login
EOF
}

while (($# > 0)); do
  case "$1" in
    --login)
      LOGIN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

if [[ -z "${SPOTIFY_CLIENT_ID:-}" ]]; then
  echo "SPOTIFY_CLIENT_ID is required" >&2
  exit 1
fi

if [[ -z "${SPOTIFY_REDIRECT_URI:-}" ]]; then
  echo "SPOTIFY_REDIRECT_URI is required" >&2
  exit 1
fi

cd "$ROOT"
npm install

setup_args=(
  setup
  --client-id "$SPOTIFY_CLIENT_ID"
  --redirect-uri "$SPOTIFY_REDIRECT_URI"
)

if [[ -n "${SPOTIFY_CLIENT_SECRET:-}" ]]; then
  setup_args+=(--client-secret "$SPOTIFY_CLIENT_SECRET")
fi

node src/bin/spotify-oauth.js "${setup_args[@]}"

if [[ "$LOGIN" == "1" ]]; then
  node src/bin/spotify-oauth.js login
fi

echo "Bootstrap complete."
echo "Start API:     npm run serve"
echo "Start Discord: npm run discord"
