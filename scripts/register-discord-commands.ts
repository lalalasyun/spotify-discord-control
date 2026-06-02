#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DISCORD_API = 'https://discord.com/api/v10';
const SPOTIFY_SUBCOMMANDS = [
  ['card', 'Post or refresh the configured playback card.'],
  ['now', 'Show the current playback state here.'],
  ['login', 'Get a Spotify authorization URL.'],
  ['play', 'Resume playback.'],
  ['pause', 'Pause playback.'],
  ['next', 'Skip to the next track.'],
  ['prev', 'Go back to the previous track.'],
  ['like', 'Toggle saved status for the current track.'],
];

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const envFile = flags.env || '.env.worker';
  const fileEnv = await readEnvFile(envFile);
  const env = { ...fileEnv, ...process.env };
  const botToken = requireValue(env.DISCORD_BOT_TOKEN, 'DISCORD_BOT_TOKEN');
  const applicationId = env.DISCORD_APPLICATION_ID || (await fetchApplicationId(botToken));
  const guildId = env.DISCORD_GUILD_ID || '';
  const endpoint = guildId
    ? `/applications/${applicationId}/guilds/${guildId}/commands`
    : `/applications/${applicationId}/commands`;

  const response = await fetch(`${DISCORD_API}${endpoint}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands()),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Discord command registration failed: ${response.status} ${body.slice(0, 500)}`,
    );
  }

  const target = guildId ? `guild ${guildId}` : 'global';
  console.log(`registered /spotify commands and aliases (${target})`);
}

function commands() {
  return [
    {
      name: 'spotify',
      description: 'Control Spotify playback and show the current track.',
      options: SPOTIFY_SUBCOMMANDS.map(([name, description]) => subcommand(name, description)),
    },
    ...SPOTIFY_SUBCOMMANDS.map(([name, description]) => ({
      name: `spotify-${name}`,
      description,
    })),
  ];
}

function subcommand(name, description) {
  return { type: 1, name, description };
}

async function fetchApplicationId(botToken) {
  const response = await fetch(`${DISCORD_API}/oauth2/applications/@me`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord application lookup failed: ${response.status} ${body.slice(0, 500)}`);
  }
  const application = await response.json();
  return requireValue(application.id, 'DISCORD_APPLICATION_ID');
}

function parseArgs(argv) {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

async function readEnvFile(filePath) {
  try {
    const text = await readFile(path.resolve(filePath), 'utf8');
    const env: Record<string, string> = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const equalsIndex = line.indexOf('=');
      if (equalsIndex < 1) continue;
      const key = line.slice(0, equalsIndex).trim();
      const value = line
        .slice(equalsIndex + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      env[key] = value;
    }
    return env;
  } catch (error) {
    if ((error as { code?: string })?.code === 'ENOENT') return {};
    throw error;
  }
}

function requireValue(value, name) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
