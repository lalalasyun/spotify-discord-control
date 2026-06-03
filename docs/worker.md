# Cloudflare Worker Deployment

Worker mode hosts the Discord side as an HTTP Interactions endpoint. It does not use the Discord Gateway or the local Server-Sent Events API.

## Architecture

```txt
Discord slash command/button
  -> Cloudflare Worker /discord/interactions
  -> Spotify Web API
  -> Discord interaction response or channel message update

Playback card sync
  -> one-minute scheduled watchdog after deploys
  -> Durable Object alarm
  -> Spotify Web API every 30 seconds while active
  -> Discord channel message update

Spotify OAuth
  -> /spotify/login or /spotify login
  -> Spotify authorize URL
  -> /spotify/callback
  -> Workers KV refresh token storage
```

## Required User-Created Apps

Create these yourself:

- Spotify Developer App
- Discord Application + Bot
- Cloudflare account

The project does not ship any shared API keys, bot tokens, or hosted endpoint.

## Environment

Copy `.env.worker.example` to `.env.worker` and fill it in.

Required:

- `WORKER_NAME`
- `PUBLIC_BASE_URL`
- `SPOTIFY_CLIENT_ID`
- `DISCORD_APPLICATION_ID`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_BOT_TOKEN`
- `DISCORD_CHANNEL_ID`

Optional:

- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REDIRECT_URI`
- `SPOTIFY_REDIRECT_PATH`
- `DISCORD_GUILD_ID`
- `KV_NAMESPACE_ID`

## Deploy

```bash
bun install
bun run deploy:worker
```

The deploy script:

1. Creates a KV namespace when `KV_NAMESPACE_ID` is absent.
2. Writes `wrangler.generated.jsonc`.
3. Configures a Durable Object alarm refresh and one-minute watchdog cron for the persistent playback card.
4. Runs `bunx wrangler deploy --secrets-file .env.worker`.
5. Registers `/spotify` commands with Discord.

`wrangler.generated.jsonc` and `.env.worker` are ignored by git.

## Discord Setup

Set the Discord Interactions Endpoint URL to:

```txt
https://YOUR_WORKER_HOST/discord/interactions
```

Discord validates the endpoint by sending a PING interaction. The Worker validates `X-Signature-Ed25519` and `X-Signature-Timestamp` with `DISCORD_PUBLIC_KEY`.

## Spotify Setup

Add the redirect URI to your Spotify app:

```txt
https://YOUR_WORKER_HOST/spotify/callback
```

Then run `/spotify login`, open the authorization URL, and complete OAuth.

## Commands

- `/spotify login`
- `/spotify card`
- `/spotify now`
- `/spotify play`
- `/spotify pause`
- `/spotify next`
- `/spotify prev`
- `/spotify like`
