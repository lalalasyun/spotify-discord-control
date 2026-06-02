#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DISCORD_API = 'https://discord.com/api/v10';
const token = process.env.DISCORD_BOT_TOKEN || '';
const channelId = process.env.DISCORD_CHANNEL_ID ||
  process.env.SPOTIFY_DISCORD_CHANNEL_ID ||
  process.env.SPOTIFY_PLAYBACK_DISCORD_CHANNEL_ID ||
  '';
const apiUrl = (process.env.SPOTIFY_PLAYBACK_API_URL || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const stateDir = process.env.SPOTIFY_DISCORD_STATE_DIR
  ? path.resolve(process.env.SPOTIFY_DISCORD_STATE_DIR)
  : process.env.SPOTIFY_PLAYBACK_STATE_DIR
    ? path.resolve(process.env.SPOTIFY_PLAYBACK_STATE_DIR)
    : path.join(os.homedir(), '.local', 'state', 'spotify-oauth-cli-discord');
const cliPath = process.env.SPOTIFY_OAUTH_COMMAND || fileURLToPath(new URL('./spotify-oauth.js', import.meta.url));
const messageIdFile = path.join(stateDir, 'last-message-id');
const trackIdFile = path.join(stateDir, 'last-track-id');
const signatureFile = path.join(stateDir, 'last-signature');
const componentPrefix = 'spotify_oauth:v1:';
const playbackActions = new Set(['prev', 'play', 'pause', 'next']);
const actions = new Set([...playbackActions, 'like']);

if (!token || !channelId) {
  console.error('DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID are required.');
  process.exit(1);
}

let stopping = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stateFile(name) {
  return path.join(stateDir, name);
}

async function readState(name) {
  try {
    return (await readFile(stateFile(name), 'utf8')).trim();
  } catch {
    return '';
  }
}

async function writeState(name, value) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(stateFile(name), `${value}\n`, { mode: 0o600 });
}

async function readLastMessageId() {
  try {
    return (await readFile(messageIdFile, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function writeLastMessageId(messageId) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(messageIdFile, `${messageId}\n`, { mode: 0o600 });
}

async function readLastTrackId() {
  try {
    return (await readFile(trackIdFile, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function writeLastTrackId(trackId) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(trackIdFile, `${trackId}\n`, { mode: 0o600 });
}

async function readLastSignature() {
  try {
    return (await readFile(signatureFile, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function writeLastSignature(signature) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(signatureFile, `${signature}\n`, { mode: 0o600 });
}

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--:--';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function displayTrack(state) {
  return state?.track || state?.lastTrack || null;
}

function artists(track) {
  const names = Array.isArray(track?.artists)
    ? track.artists.map((artist) => artist?.name).filter(Boolean)
    : [];
  return names.length ? names.join(', ') : 'Unknown artist';
}

function albumArtworkUrl(track) {
  const images = Array.isArray(track?.album?.images) ? track.album.images.filter((image) => image?.url) : [];
  return images.sort((a, b) => (b?.width || 0) - (a?.width || 0))[0]?.url || '';
}

function stateSignature(eventType, state) {
  const trackId = displayTrack(state)?.id || 'none';
  const deviceId = state?.device?.id || 'none';
  const playback = state?.playbackState || 'unknown';
  const playing = state?.isPlaying ? 'playing' : 'paused';
  return `${eventType}:${playback}:${playing}:${trackId}:${deviceId}`;
}

function buildControls(state) {
  const toggleAction = state?.isPlaying ? 'pause' : 'play';
  const toggleEmoji = state?.isPlaying ? '⏸️' : '▶️';
  const likeDisabled = !displayTrack(state)?.id;

  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          custom_id: `${componentPrefix}prev`,
          style: 2,
          emoji: { name: '⏮️' }
        },
        {
          type: 2,
          custom_id: `${componentPrefix}${toggleAction}`,
          style: state?.isPlaying ? 2 : 3,
          emoji: { name: toggleEmoji }
        },
        {
          type: 2,
          custom_id: `${componentPrefix}next`,
          style: 2,
          emoji: { name: '⏭️' }
        },
        {
          type: 2,
          custom_id: `${componentPrefix}like`,
          style: 2,
          emoji: { name: '➕' },
          disabled: likeDisabled
        }
      ]
    }
  ];
}

function formatMessage(eventType, state) {
  const track = displayTrack(state) || {};
  const album = track.album?.name || 'Unknown album';
  const device = state?.device?.name || 'unknown device';
  const status = state?.playbackState || (state?.isPlaying ? 'playing' : 'paused');
  const position = `${formatMs(state?.positionMs || 0)} / ${formatMs(track.durationMs || 0)}`;
  const spotifyUrl = track.id ? `https://open.spotify.com/track/${track.id}` : undefined;
  const artworkUrl = albumArtworkUrl(track);

  const embed = {
    title: track.name || 'Unknown track',
    url: spotifyUrl,
    description: artists(track),
    color: state?.isPlaying ? 0x1db954 : 0x808080,
    fields: [
      { name: 'Status', value: status, inline: true },
      { name: 'Position', value: position, inline: true },
      { name: 'Device', value: device, inline: true },
      { name: 'Album', value: album, inline: false }
    ],
    footer: {
      text: `${eventType}${state?.inactiveReason ? ` | ${state.inactiveReason}` : ''} | version ${state?.version ?? 'unknown'}`
    },
    timestamp: state?.updatedAt || undefined
  };
  if (artworkUrl) embed.image = { url: artworkUrl };

  return {
    content: '',
    embeds: [embed],
    components: buildControls(state)
  };
}

function cleanMessage(message) {
  return {
    content: message?.content || '',
    embeds: Array.isArray(message?.embeds) ? message.embeds : [],
    components: Array.isArray(message?.components) ? message.components : []
  };
}

function disablePlaybackButtons(message) {
  const cleaned = cleanMessage(message);
  return {
    ...cleaned,
    components: cleaned.components.map((row) => ({
      ...row,
      components: Array.isArray(row?.components)
        ? row.components.map((component) => {
            const action = actionFromCustomId(component?.custom_id || '');
            return playbackActions.has(action) ? { ...component, disabled: true } : component;
          })
        : row?.components
    }))
  };
}

function updateLikeButton(message, saved) {
  const cleaned = cleanMessage(message);
  return {
    ...cleaned,
    components: cleaned.components.map((row) => ({
      ...row,
      components: Array.isArray(row?.components)
        ? row.components.map((component) => {
            const action = actionFromCustomId(component?.custom_id || '');
            if (action !== 'like') return component;
            return {
              ...component,
              style: saved ? 3 : 2,
              emoji: { name: saved ? '✔️' : '➕' }
            };
          })
        : row?.components
    }))
  };
}

function actionFromCustomId(customId) {
  return customId.startsWith(componentPrefix) ? customId.slice(componentPrefix.length) : '';
}

function trackIdFromSpotifyUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parsed.hostname === 'open.spotify.com' && parts[0] === 'track' ? parts[1] || '' : '';
  } catch {
    return '';
  }
}

function trackIdFromMessage(message) {
  for (const embed of Array.isArray(message?.embeds) ? message.embeds : []) {
    const trackId = trackIdFromSpotifyUrl(embed?.url);
    if (trackId) return trackId;
  }
  return '';
}

async function discordRequest(method, endpoint, payload = null, softStatuses = []) {
  const response = await fetch(`${DISCORD_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json'
    },
    body: payload ? JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }) : undefined
  });

  if (response.status === 429) {
    const body = await response.json().catch(() => ({}));
    await sleep(Number(body.retry_after || 1) * 1000);
    return discordRequest(method, endpoint, payload, softStatuses);
  }

  if (softStatuses.includes(response.status)) {
    return { unavailable: true, status: response.status };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord ${method} ${endpoint} failed: ${response.status} ${body.slice(0, 300)}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function postMessage(message) {
  const result = await discordRequest('POST', `/channels/${channelId}/messages`, message);
  return result.id;
}

async function editMessage(messageId, message) {
  const result = await discordRequest('PATCH', `/channels/${channelId}/messages/${messageId}`, message, [403, 404]);
  return !result?.unavailable;
}

async function fetchMessage(messageId) {
  return discordRequest('GET', `/channels/${channelId}/messages/${messageId}`, null, [403, 404]);
}

async function upsertPlaybackMessage(message, trackId) {
  const lastMessageId = await readLastMessageId();
  const lastTrackId = await readLastTrackId();

  if (lastMessageId && lastTrackId === trackId && await editMessage(lastMessageId, message)) {
    return { action: 'edited', messageId: lastMessageId };
  }

  const createdMessageId = await postMessage(message);
  if (lastMessageId && lastMessageId !== createdMessageId) {
    const previous = await fetchMessage(lastMessageId);
    if (!previous?.unavailable) {
      await editMessage(lastMessageId, disablePlaybackButtons(previous)).catch(() => {});
    }
  }
  await writeLastMessageId(createdMessageId);
  await writeLastTrackId(trackId);
  return { action: 'posted', messageId: createdMessageId };
}

async function handlePlaybackEvent(eventType, payload) {
  const state = payload?.state || payload;
  if (!state || typeof state !== 'object') return;

  const signature = stateSignature(eventType, state);
  if (signature === await readLastSignature()) return;

  const trackId = displayTrack(state)?.id || 'none';
  const result = await upsertPlaybackMessage(formatMessage(eventType, state), trackId);
  await writeLastSignature(signature);
  console.log(`${result.action} ${eventType} version=${state.version ?? 'unknown'} message=${result.messageId}`);
}

async function fetchFreshState() {
  const response = await fetch(`${apiUrl}/playback/state`);
  if (!response.ok) throw new Error(`playback state fetch failed: ${response.status}`);
  const payload = await response.json();
  return payload.state;
}

async function waitForFreshState(signal) {
  while (!signal.aborted) {
    try {
      return await fetchFreshState();
    } catch (error) {
      console.error(`playback API unavailable: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(5_000);
    }
  }
  return null;
}

function runSpotify(action, trackId = '') {
  const command = action === 'like' ? 'toggle-like' : action;
  const env = { ...process.env };
  if (trackId) env.SPOTIFY_OAUTH_TRACK_ID = trackId;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, command, '--json'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({ ok: false, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
  });
}

async function acknowledgeInteraction(interaction) {
  await fetch(`${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 6 })
  });
}

async function handleInteraction(interaction) {
  const action = actionFromCustomId(interaction?.data?.custom_id || '');
  if (!actions.has(action)) return;

  await acknowledgeInteraction(interaction);

  const messageId = interaction?.message?.id || '';
  const lastMessageId = await readLastMessageId();
  const isStale = Boolean(messageId && lastMessageId && messageId !== lastMessageId);
  if (isStale && playbackActions.has(action)) {
    await editMessage(messageId, disablePlaybackButtons(interaction.message)).catch(() => {});
    return;
  }

  const result = await runSpotify(action, action === 'like' ? trackIdFromMessage(interaction.message) : '');
  if (!result.ok) {
    console.error(`control ${action} failed: ${result.stderr || result.stdout || 'unknown error'}`);
  }

  await sleep(750);
  const targetMessageId = messageId || lastMessageId;
  if (!targetMessageId) return;

  if (action === 'like') {
    const parsed = safeJson(result.stdout);
    if (parsed && typeof parsed.saved === 'boolean') {
      await editMessage(targetMessageId, updateLikeButton(interaction.message, parsed.saved));
      return;
    }
  }

  try {
    const state = await fetchFreshState();
    await editMessage(targetMessageId, formatMessage('control', state));
  } catch (error) {
    console.error(`control ${action} refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function getGatewayUrl() {
  const result = await discordRequest('GET', '/gateway/bot');
  return `${result.url || 'wss://gateway.discord.gg'}/?v=10&encoding=json`;
}

async function runGateway(signal) {
  if (typeof WebSocket !== 'function') {
    throw new Error('Node.js WebSocket global is unavailable. Use Node 22 or newer.');
  }

  const socket = new WebSocket(await getGatewayUrl());
  let sequence = null;
  let heartbeatTimer = null;

  const send = (op, d) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ op, d }));
    }
  };

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      socket.close(1000, 'shutdown');
      resolve();
    };

    signal.addEventListener('abort', abort);
    socket.addEventListener('message', (event) => {
      const packet = JSON.parse(event.data);
      if (packet.s !== null && packet.s !== undefined) sequence = packet.s;

      if (packet.op === 10) {
        heartbeatTimer = setInterval(() => send(1, sequence), packet.d?.heartbeat_interval || 45_000);
        send(2, {
          token,
          intents: 1,
          properties: {
            os: process.platform,
            browser: 'spotify-discord-bot',
            device: 'spotify-discord-bot'
          }
        });
        return;
      }
      if (packet.op === 1) send(1, sequence);
      if (packet.op === 7 || packet.op === 9) socket.close(4000, 'reconnect');
      if (packet.t === 'INTERACTION_CREATE') {
        handleInteraction(packet.d).catch((error) => {
          console.error(error instanceof Error ? error.message : String(error));
        });
      }
    });
    socket.addEventListener('error', () => {
      cleanup();
      reject(new Error('Discord gateway websocket error'));
    });
    socket.addEventListener('close', () => {
      cleanup();
      resolve();
    });
  });
}

async function maintainGateway(signal) {
  while (!stopping && !signal.aborted) {
    try {
      await runGateway(signal);
    } catch (error) {
      if (!stopping && !signal.aborted) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
    if (!stopping && !signal.aborted) await sleep(5_000);
  }
}

async function consumeEvents(signal) {
  const response = await fetch(`${apiUrl}/events`, { signal });
  if (!response.ok || !response.body) {
    throw new Error(`SSE connect failed: ${response.status}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';
  let currentData = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let splitIndex;
    while ((splitIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, splitIndex).replace(/\r$/, '');
      buffer = buffer.slice(splitIndex + 1);

      if (!line) {
        if (currentData) {
          await handlePlaybackEvent(currentEvent, JSON.parse(currentData));
        }
        currentEvent = 'message';
        currentData = '';
        continue;
      }
      if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
      if (line.startsWith('data:')) currentData += line.slice(5).trim();
    }
  }
}

async function main() {
  const controller = new AbortController();
  const shutdown = () => {
    stopping = true;
    controller.abort();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const state = await waitForFreshState(controller.signal);
  if (state) {
    await handlePlaybackEvent('snapshot', { state });
  }
  maintainGateway(controller.signal).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
  });

  while (!stopping) {
    try {
      await consumeEvents(controller.signal);
    } catch (error) {
      if (!stopping) {
        console.error(error instanceof Error ? error.message : String(error));
        await sleep(5_000);
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
