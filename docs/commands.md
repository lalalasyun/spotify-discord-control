# Commands

## Setup

```bash
bun install
cp .env.example .env
bun run bootstrap -- --login
```

## Local Runtime

```bash
bun run serve
bun run discord
```

Register Discord slash commands for the local Gateway bot:

```bash
DISCORD_GUILD_ID=your_server_id bun run register:discord -- --env .env
```

Omit `DISCORD_GUILD_ID` only when you want global commands and can wait for Discord propagation.

## Worker Runtime

```bash
cp .env.worker.example .env.worker
bun run deploy:worker
```

## Development

```bash
bun run check
bun run typecheck
bun run lint
bun run format
bun test
```

`bun run check` is the main local gate. It runs TypeScript with `tsc --noEmit`, Biome linting, and Bun tests.
