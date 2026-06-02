# Scope

## Included

- Node.js 22+ の標準 API を中心に実装する
- OAuth Authorization Code with PKCE
- Redirect URI の既定案: `http://127.0.0.1:8787/callback`
- Spotify playback state API
- Playback controls: `play`, `pause`, `next`, `prev`, `transfer`
- Library controls: `saved`, `like`, `unlike`, `toggle-like`
- Local API: `GET /health`, `GET /playback/state`, `GET /events`
- Discord bot: playback card, previous/play-pause/next/like buttons
- `.env.example`
- Doppler setup notes

## Required Scopes

```txt
user-read-playback-state
user-read-currently-playing
user-modify-playback-state
user-library-read
user-library-modify
```

## Not Included

- Generated Spotify credentials
- Generated Discord bot credentials
- Hosted service
- Docker image
- systemd unit templates
- playlist/search/recommendation UX

## Acceptance Criteria

- A user can clone the repo, fill `.env`, and run `npm run bootstrap -- --login`
- CLI syntax checks pass
- Public docs contain no private hostnames or personal environment assumptions
- Discord integration only needs bot token, channel id, and the local playback API
