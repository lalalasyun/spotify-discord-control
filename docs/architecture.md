# Architecture

## Components

- `spotify-oauth`: CLI for setup, login, token refresh, playback state, playback control, and library control
- `spotify-oauth serve`: local HTTP API and SSE stream
- `spotify-discord-bot`: Discord REST/Gateway client that posts playback cards and handles button interactions

## Flow

1. User creates Spotify Developer App and Discord bot.
2. User runs `spotify-oauth setup` and `spotify-oauth login`.
3. `spotify-oauth serve` exposes current playback state on localhost.
4. `spotify-discord-bot` reads the local API, posts a playback card, and subscribes to SSE.
5. Discord button interactions call `spotify-oauth play/pause/next/prev/toggle-like`.

## State

- Spotify config and OAuth tokens: `~/.config/spotify-oauth-cli/`
- Discord message state: `~/.local/state/spotify-oauth-cli-discord/`
- Both paths can be overridden with environment variables.

## External Dependencies

- Spotify Web API
- Discord REST API
- Discord Gateway
- Optional Doppler for app credentials

## Hosting

Hosting is caller-managed. The app needs two long-running commands:

```bash
npm run serve
npm run discord
```
