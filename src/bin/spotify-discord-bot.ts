#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DISCORD_API = 'https://discord.com/api/v10';
const token = process.env.DISCORD_BOT_TOKEN || '';
const channelId =
  process.env.DISCORD_CHANNEL_ID ||
  process.env.SPOTIFY_DISCORD_CHANNEL_ID ||
  process.env.SPOTIFY_PLAYBACK_DISCORD_CHANNEL_ID ||
  '';
const apiUrl = (process.env.SPOTIFY_PLAYBACK_API_URL || 'http://127.0.0.1:8788').replace(
  /\/+$/,
  '',
);
const stateDir = process.env.SPOTIFY_DISCORD_STATE_DIR
  ? path.resolve(process.env.SPOTIFY_DISCORD_STATE_DIR)
  : process.env.SPOTIFY_PLAYBACK_STATE_DIR
    ? path.resolve(process.env.SPOTIFY_PLAYBACK_STATE_DIR)
    : path.join(os.homedir(), '.local', 'state', 'spotify-oauth-cli-discord');
const cliPath =
  process.env.SPOTIFY_OAUTH_COMMAND ||
  fileURLToPath(new URL('./spotify-oauth.ts', import.meta.url));
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
  const images = Array.isArray(track?.album?.images)
    ? track.album.images.filter((image) => image?.url)
    : [];
  return images.sort((a, b) => (b?.width || 0) - (a?.width || 0))[0]?.url || '';
}

function stateSignature(eventType, state) {
  const trackId = displayTrack(state)?.id || 'none';
  const deviceId = state?.device?.id || 'none';
  const playback = state?.playbackState || 'unknown';
  const playing = state?.isPlaying ? 'playing' : 'paused';
  return `${eventType}:${playback}:${playing}:${trackId}:${deviceId}`;
}

function buildControls(state, saved = null) {
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
          emoji: { name: '⏮️' },
        },
        {
          type: 2,
          custom_id: `${componentPrefix}${toggleAction}`,
          style: state?.isPlaying ? 2 : 3,
          emoji: { name: toggleEmoji },
        },
        {
          type: 2,
          custom_id: `${componentPrefix}next`,
          style: 2,
          emoji: { name: '⏭️' },
        },
        {
          type: 2,
          custom_id: `${componentPrefix}like`,
          style: saved === true ? 3 : 2,
          emoji: { name: saved === true ? '✔️' : '➕' },
          disabled: likeDisabled,
        },
      ],
    },
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

  const embed: any = {
    title: track.name || 'Unknown track',
    url: spotifyUrl,
    description: artists(track),
    color: state?.isPlaying ? 0x1db954 : 0x808080,
    fields: [
      { name: 'Status', value: status, inline: true },
      { name: 'Position', value: position, inline: true },
      { name: 'Device', value: device, inline: true },
      { name: 'Album', value: album, inline: false },
    ],
    footer: {
      text: `${eventType}${state?.inactiveReason ? ` | ${state.inactiveReason}` : ''} | version ${state?.version ?? 'unknown'}`,
    },
    timestamp: state?.updatedAt || undefined,
  };
  if (artworkUrl) embed.image = { url: artworkUrl };

  return {
    content: '',
    embeds: [embed],
    components: buildControls(state),
  };
}

async function formatPlaybackMessage(eventType, state) {
  const saved = await fetchTrackSaved(state);
  return {
    ...formatMessage(eventType, state),
    components: buildControls(state, saved),
  };
}

async function fetchTrackSaved(state) {
  const trackId = displayTrack(state)?.id || '';
  if (!trackId) return null;
  const result: any = await runSpotify('saved', trackId);
  if (!result.ok) {
    console.error(`saved state check failed: ${result.stderr || result.stdout || 'unknown error'}`);
    return null;
  }
  const parsed = safeJson(result.stdout);
  return typeof parsed?.saved === 'boolean' ? parsed.saved : null;
}

function cleanMessage(message) {
  return {
    content: message?.content || '',
    embeds: Array.isArray(message?.embeds) ? message.embeds : [],
    components: Array.isArray(message?.components) ? message.components : [],
  };
}

function withAllowedMentions(message) {
  return { ...message, allowed_mentions: { parse: [] } };
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
        : row?.components,
    })),
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
              emoji: { name: saved ? '✔️' : '➕' },
            };
          })
        : row?.components,
    })),
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
      'Content-Type': 'application/json',
    },
    body: payload ? JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }) : undefined,
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
    throw new Error(
      `Discord ${method} ${endpoint} failed: ${response.status} ${body.slice(0, 300)}`,
    );
  }

  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function postMessage(message) {
  const result = await discordRequest('POST', `/channels/${channelId}/messages`, message);
  return result.id;
}

async function editMessage(messageId, message) {
  const result = await discordRequest(
    'PATCH',
    `/channels/${channelId}/messages/${messageId}`,
    message,
    [403, 404],
  );
  return !result?.unavailable;
}

async function fetchMessage(messageId) {
  return discordRequest('GET', `/channels/${channelId}/messages/${messageId}`, null, [403, 404]);
}

async function upsertPlaybackMessage(message, trackId) {
  const lastMessageId = await readLastMessageId();
  const lastTrackId = await readLastTrackId();

  if (lastMessageId && lastTrackId === trackId && (await editMessage(lastMessageId, message))) {
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
  if (signature === (await readLastSignature())) return;

  const trackId = displayTrack(state)?.id || 'none';
  const result = await upsertPlaybackMessage(
    await formatPlaybackMessage(eventType, state),
    trackId,
  );
  await writeLastSignature(signature);
  console.log(
    `${result.action} ${eventType} version=${state.version ?? 'unknown'} message=${result.messageId}`,
  );
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
      console.error(
        `playback API unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      stdio: ['ignore', 'pipe', 'pipe'],
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
    body: JSON.stringify({ type: 6 }),
  });
}

async function deferInteraction(interaction, ephemeral = false) {
  const data = ephemeral ? { flags: 64 } : {};
  const response = await fetch(
    `${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 5, data }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Discord interaction defer failed: ${response.status} ${body.slice(0, 300)}`);
  }
}

async function editInteractionResponse(interaction, message) {
  const payload = typeof message === 'string' ? { content: message } : withAllowedMentions(message);
  const response = await fetch(
    `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Discord interaction response edit failed: ${response.status} ${body.slice(0, 300)}`,
    );
  }
}

function applicationCommandSubcommand(interaction) {
  return interaction?.data?.options?.[0]?.name || 'card';
}

async function handleApplicationCommand(interaction) {
  const subcommand = applicationCommandSubcommand(interaction);
  const ephemeral = subcommand === 'card' || subcommand === 'login';

  try {
    await deferInteraction(interaction, ephemeral);

    if (subcommand === 'login') {
      await editInteractionResponse(
        interaction,
        'Local mode uses the host Spotify OAuth session. Run `spotify-oauth login` on the host if authorization is needed.',
      );
      return;
    }

    if (subcommand === 'card' || subcommand === 'now') {
      const state = await fetchFreshState();
      const message = await formatPlaybackMessage(subcommand, state);
      if (subcommand === 'card') {
        const result = await upsertPlaybackMessage(message, displayTrack(state)?.id || 'none');
        await editInteractionResponse(interaction, `Playback card ${result.action}.`);
        return;
      }
      await editInteractionResponse(interaction, message);
      return;
    }

    if (playbackActions.has(subcommand) || subcommand === 'like') {
      const result: any = await runSpotify(subcommand);
      if (!result.ok) {
        await editInteractionResponse(
          interaction,
          `Spotify ${subcommand} failed: ${result.stderr || result.stdout || 'unknown error'}`,
        );
        return;
      }

      await sleep(750);
      const state = await fetchFreshState();
      if (subcommand === 'like') {
        const parsed = safeJson(result.stdout);
        await editInteractionResponse(interaction, {
          ...formatMessage(parsed?.saved ? 'liked' : 'unliked', state),
          components: buildControls(
            state,
            typeof parsed?.saved === 'boolean' ? parsed.saved : await fetchTrackSaved(state),
          ),
        });
        return;
      }

      await editInteractionResponse(interaction, await formatPlaybackMessage('control', state));
      return;
    }

    await editInteractionResponse(interaction, `Unknown command: ${subcommand}`);
  } catch (error) {
    await editInteractionResponse(
      interaction,
      error instanceof Error ? error.message : String(error),
    ).catch((responseError) => {
      console.error(responseError instanceof Error ? responseError.message : String(responseError));
    });
  }
}

async function handleComponentInteraction(interaction) {
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

  const result: any = await runSpotify(
    action,
    action === 'like' ? trackIdFromMessage(interaction.message) : '',
  );
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
    await editMessage(targetMessageId, await formatPlaybackMessage('control', state));
  } catch (error) {
    console.error(
      `control ${action} refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleInteraction(interaction) {
  if (interaction?.type === 2) {
    await handleApplicationCommand(interaction);
    return;
  }
  if (interaction?.type === 3) {
    await handleComponentInteraction(interaction);
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

async function runGateway(signal, gatewayUrl) {
  if (typeof WebSocket !== 'function') {
    throw new Error('WebSocket global is unavailable. Use Bun 1.3 or newer.');
  }

  console.log('discord gateway connecting');
  const socket = new WebSocket(gatewayUrl);
  let sequence = null;
  let heartbeatTimer = null;

  const send = (op, d) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ op, d }));
    }
  };

  return new Promise<void>((resolve, reject) => {
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
        heartbeatTimer = setInterval(
          () => send(1, sequence),
          packet.d?.heartbeat_interval || 45_000,
        );
        console.log('discord gateway hello');
        send(2, {
          token,
          intents: 1,
          properties: {
            os: process.platform,
            browser: 'spotify-discord-bot',
            device: 'spotify-discord-bot',
          },
        });
        return;
      }
      if (packet.t === 'READY') {
        console.log(`discord gateway ready session=${packet.d?.session_id || 'unknown'}`);
      }
      if (packet.op === 1) send(1, sequence);
      if (packet.op === 7 || packet.op === 9) socket.close(4000, 'reconnect');
      if (packet.t === 'INTERACTION_CREATE') {
        console.log(
          `discord interaction type=${packet.d?.type || 'unknown'} command=${packet.d?.data?.name || packet.d?.data?.custom_id || 'unknown'}`,
        );
        handleInteraction(packet.d).catch((error) => {
          console.error(error instanceof Error ? error.message : String(error));
        });
      }
    });
    socket.addEventListener('error', () => {
      cleanup();
      reject(new Error('Discord gateway websocket error'));
    });
    socket.addEventListener('close', (event) => {
      cleanup();
      console.error(`Discord gateway closed: ${event.code} ${event.reason || ''}`.trim());
      resolve();
    });
  });
}

async function maintainGateway(signal, gatewayUrl) {
  while (!stopping && !signal.aborted) {
    try {
      console.log('discord gateway loop start');
      await runGateway(signal, gatewayUrl);
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

  for await (const chunk of response.body as any) {
    buffer += decoder.decode(chunk, { stream: true });
    let splitIndex = buffer.indexOf('\n');
    while (splitIndex >= 0) {
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
      splitIndex = buffer.indexOf('\n');
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
  const gatewayUrl = await getGatewayUrl();
  console.log('discord gateway url fetched');
  maintainGateway(controller.signal, gatewayUrl).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
  });
  await sleep(2_000);

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
