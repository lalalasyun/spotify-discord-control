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
