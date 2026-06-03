# spotify-discord-control

Spotify 公式 Web API と OAuth PKCE で、現在の再生状態取得、再生操作、Discord への再生カード投稿を行う小さな TypeScript/Bun CLI。

## Features

- Spotify OAuth Authorization Code with PKCE
- `now`, `devices`, `play`, `pause`, `next`, `prev`, `transfer`
- `saved`, `like`, `unlike`, `toggle-like`
- Local playback API: `GET /playback/state`
- Server-Sent Events: `GET /events`
- Discord bot with playback buttons
- env file or Doppler based setup
- Optional Cloudflare Worker deployment with Discord Interactions

## Requirements

- Bun 1.3+
- Spotify account
- Spotify Developer App
- Discord bot and target channel, if you use Discord integration
- Cloudflare account, if you use Worker deployment

Spotify playback control requires an active Spotify device. Some playback API operations require Spotify Premium.

## Spotify App Setup

Create your own app in the Spotify Developer Dashboard:

<https://developer.spotify.com/dashboard>

Set this Redirect URI first:

```txt
http://127.0.0.1:8787/callback
```

This project requests these scopes:

```txt
user-read-playback-state
user-read-currently-playing
user-modify-playback-state
user-library-read
user-library-modify
```

PKCE works without a client secret. `SPOTIFY_CLIENT_SECRET` is optional.

## One Command Setup

```bash
git clone https://github.com/lalalasyun/spotify-discord-control.git
cd spotify-discord-control
cp .env.example .env
```

Edit `.env`:

```env
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8787/callback
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_CHANNEL_ID=your_discord_channel_id
```

Then run:

```bash
bun install
bun run bootstrap -- --login
```

## Doppler Setup

You can keep app credentials in Doppler:

```bash
doppler setup
doppler secrets set SPOTIFY_CLIENT_ID=...
doppler secrets set SPOTIFY_REDIRECT_URI=http://127.0.0.1:8787/callback
doppler secrets set DISCORD_BOT_TOKEN=...
doppler secrets set DISCORD_CHANNEL_ID=...
doppler run -- bun run bootstrap -- --login
```

OAuth access and refresh tokens are stored locally by the CLI, not in Doppler.

## CLI Usage

```bash
spotify-oauth status
spotify-oauth now --json
spotify-oauth devices --json
spotify-oauth play
spotify-oauth pause
spotify-oauth next
spotify-oauth prev
spotify-oauth transfer <device_id>
spotify-oauth saved
spotify-oauth toggle-like
```

## Local API

Start the playback API:

```bash
bun run serve
```

Endpoints:

- `GET /health`
- `GET /playback/state`
- `GET /events`

## Discord Bot

Start the local API first:

```bash
bun run serve
```

In another shell:

```bash
bun run discord
```

The bot posts a playback card to `DISCORD_CHANNEL_ID` and listens for button interactions:

- previous
- play / pause
- next
- like toggle

It can also receive Discord slash commands over the Gateway after command registration:

```bash
DISCORD_GUILD_ID=your_server_id bun run register:discord -- --env .env
```

This registers the grouped `/spotify ...` command.

Create the Discord bot yourself in the Discord Developer Portal and invite it to your server with permissions to read/send messages and use message components.

## Cloudflare Worker Setup

The Worker mode is for users who want a hosted Discord Interactions webhook instead of a long-running local Discord Gateway process.

It provides:

- `POST /discord/interactions` for Discord slash commands and buttons
- `GET /spotify/callback` for Spotify OAuth PKCE callback
- Workers KV token storage
- Durable Object alarm refresh of the configured playback card every 30 seconds while playback is active, with a one-minute cron watchdog to bootstrap the alarm after deploys
- `/spotify card`, `now`, `login`, `play`, `pause`, `next`, `prev`, `like`

Create your Spotify app and Discord app yourself. In Spotify, add this redirect URI:

```txt
https://spotify-discord-control.YOUR_SUBDOMAIN.workers.dev/spotify/callback
```

In Discord, the Interactions Endpoint URL will be:

```txt
https://spotify-discord-control.YOUR_SUBDOMAIN.workers.dev/discord/interactions
```

Then deploy:

```bash
cp .env.worker.example .env.worker
```

Edit `.env.worker`:

```env
WORKER_NAME=spotify-discord-control
PUBLIC_BASE_URL=https://spotify-discord-control.YOUR_SUBDOMAIN.workers.dev
SPOTIFY_CLIENT_ID=your_spotify_client_id
DISCORD_APPLICATION_ID=your_discord_application_id
DISCORD_PUBLIC_KEY=your_discord_public_key
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_CHANNEL_ID=your_discord_channel_id
```

Run the one-command deploy:

```bash
bun install
bun run deploy:worker
```

The deploy script creates a Workers KV namespace when `KV_NAMESPACE_ID` is not set, writes `wrangler.generated.jsonc`, configures a Durable Object alarm playback card refresh plus a one-minute watchdog cron, deploys the Worker with `bunx wrangler deploy --secrets-file .env.worker`, and registers Discord slash commands.

After deploy:

1. Set the Discord Interactions Endpoint URL printed by the script.
2. Run `/spotify login` in Discord.
3. Open the Spotify authorization URL and complete OAuth.
4. Run `/spotify card`.

For fast command iteration during setup, set `DISCORD_GUILD_ID` in `.env.worker`. Omit it for global commands.

## Hosting

Hosting is intentionally left to the user. Common options:

- systemd user services
- Docker or compose wrapper
- tmux/screen
- Cloudflare Workers, using `bun run deploy:worker`
- any process manager that can run two commands:
  - `bun run serve`
  - `bun run discord`

## Development

```bash
bun run check
bun run typecheck
bun run lint
bun test
bun run format
```

See `docs/commands.md` and `docs/architecture.md` for the command surface and project structure.

Keep `.env`, Spotify OAuth token files, and Discord bot tokens out of git.

## Token Storage

By default, config and tokens are stored under:

```txt
~/.config/spotify-oauth-cli/
```

Files are written with `0600` permissions. Override with `SPOTIFY_OAUTH_CONFIG_DIR`.
