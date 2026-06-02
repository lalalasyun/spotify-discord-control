# spotify-discord-control

Spotify 公式 Web API と OAuth PKCE で、現在の再生状態取得、再生操作、Discord への再生カード投稿を行う小さな Node.js CLI。

## Features

- Spotify OAuth Authorization Code with PKCE
- `now`, `devices`, `play`, `pause`, `next`, `prev`, `transfer`
- `saved`, `like`, `unlike`, `toggle-like`
- Local playback API: `GET /playback/state`
- Server-Sent Events: `GET /events`
- Discord bot with playback buttons
- env file or Doppler based setup

## Requirements

- Node.js 22+
- Spotify account
- Spotify Developer App
- Discord bot and target channel, if you use Discord integration

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
npm run bootstrap -- --login
```

## Doppler Setup

You can keep app credentials in Doppler:

```bash
doppler setup
doppler secrets set SPOTIFY_CLIENT_ID=...
doppler secrets set SPOTIFY_REDIRECT_URI=http://127.0.0.1:8787/callback
doppler secrets set DISCORD_BOT_TOKEN=...
doppler secrets set DISCORD_CHANNEL_ID=...
doppler run -- npm run bootstrap -- --login
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
npm run serve
```

Endpoints:

- `GET /health`
- `GET /playback/state`
- `GET /events`

## Discord Bot

Start the local API first:

```bash
npm run serve
```

In another shell:

```bash
npm run discord
```

The bot posts a playback card to `DISCORD_CHANNEL_ID` and listens for button interactions:

- previous
- play / pause
- next
- like toggle

Create the Discord bot yourself in the Discord Developer Portal and invite it to your server with permissions to read/send messages and use message components.

## Hosting

Hosting is intentionally left to the user. Common options:

- systemd user services
- Docker or compose wrapper
- tmux/screen
- any process manager that can run two commands:
  - `npm run serve`
  - `npm run discord`

Keep `.env`, Spotify OAuth token files, and Discord bot tokens out of git.

## Token Storage

By default, config and tokens are stored under:

```txt
~/.config/spotify-oauth-cli/
```

Files are written with `0600` permissions. Override with `SPOTIFY_OAUTH_CONFIG_DIR`.
