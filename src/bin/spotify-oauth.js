#!/usr/bin/env node

import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = process.env.SPOTIFY_OAUTH_CONFIG_DIR
  ? path.resolve(process.env.SPOTIFY_OAUTH_CONFIG_DIR)
  : path.join(os.homedir(), '.config', 'spotify-oauth-cli');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const TOKEN_PATH = path.join(CONFIG_DIR, 'tokens.json');
const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_API_PORT = 8788;
const DEFAULT_CALLBACK_PORT = 8787;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const POSITION_DRIFT_THRESHOLD_MS = 5_000;
const SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
  'user-library-read',
  'user-library-modify'
];

const usage = `spotify-oauth <command> [options]

Commands:
  setup --client-id <id> --redirect-uri <uri> [--client-secret <secret>]
                Client ID と Redirect URI を保存
  login [--callback-port <port>]
                OAuth PKCE ログインを開始
  status        設定と認証状態を表示
  now --json    現在の再生状況を JSON で表示
  devices --json
                利用可能なデバイス一覧を JSON で表示
  serve [--port <port>] [--poll-interval-ms <ms>]
                ローカル HTTP API と SSE を起動
  play|pause|next|prev
                Spotify の再生を操作
  transfer <device_id>
                再生デバイスを切り替え
  saved|like|unlike|toggle-like
                現在の曲の library 保存状態を確認/変更

Options:
  --json        JSON で出力
  --no-open     ブラウザを自動で開かない
`;

async function main() {
  const { command, args, flags } = parseArgs(process.argv.slice(2));
  if (!command || flags.help) {
    console.log(usage);
    process.exit(0);
  }

  switch (command) {
    case 'setup':
      await handleSetup(flags);
      return;
    case 'login':
      await handleLogin(flags);
      return;
    case 'status':
      await handleStatus(flags);
      return;
    case 'now':
      await handleNow(flags);
      return;
    case 'devices':
      await handleDevices(flags);
      return;
    case 'serve':
      await handleServe(flags);
      return;
    case 'play':
    case 'pause':
    case 'next':
    case 'prev':
    case 'previous':
      await handlePlaybackControl(command, flags);
      return;
    case 'transfer':
      await handleTransfer(args, flags);
      return;
    case 'saved':
      await handleSaved(flags);
      return;
    case 'like':
      await handleLibrarySave(true, flags);
      return;
    case 'unlike':
      await handleLibrarySave(false, flags);
      return;
    case 'toggle-like':
      await handleToggleLike(flags);
      return;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }

    if (value === '--help' || value === '-h') {
      flags.help = true;
      continue;
    }

    if (value.startsWith('--no-')) {
      flags[value.slice(5)] = false;
      continue;
    }

    const [rawKey, rawInlineValue] = value.slice(2).split('=', 2);
    if (rawInlineValue !== undefined) {
      flags[rawKey] = rawInlineValue;
      continue;
    }

    const nextValue = argv[index + 1];
    if (nextValue && !nextValue.startsWith('--')) {
      flags[rawKey] = nextValue;
      index += 1;
      continue;
    }

    flags[rawKey] = true;
  }

  return { command: positional[0], args: positional.slice(1), flags };
}

async function handleSetup(flags) {
  const clientId = readStringFlag(flags['client-id']);
  const redirectUri = readStringFlag(flags['redirect-uri']);
  const clientSecret = readOptionalStringFlag(flags['client-secret']);
  assertRedirectUri(redirectUri);

  const existingConfig = await loadConfig();
  const nextConfig = {
    ...existingConfig,
    clientId,
    redirectUri,
    ...(clientSecret ? { clientSecret } : {})
  };

  await saveConfig(nextConfig);
  console.error(`設定を保存しました: ${CONFIG_PATH}`);
}

async function handleLogin(flags) {
  const config = await requireConfig();
  const callbackPort = resolveCallbackPort(config.redirectUri, flags['callback-port']);
  const verifier = base64UrlEncode(randomBytes(64));
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
  const state = base64UrlEncode(randomBytes(32));
  const authorizeUrl = new URL('https://accounts.spotify.com/authorize');
  authorizeUrl.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: SCOPES.join(' ')
  }).toString();

  const callbackPromise = waitForAuthorizationCode({
    redirectUri: config.redirectUri,
    callbackPort,
    expectedState: state
  });

  const shouldOpenBrowser = flags.open !== false;
  if (shouldOpenBrowser) {
    const opened = openUrl(authorizeUrl.toString());
    if (!opened) {
      console.error('ブラウザを自動で開けなかったため、以下の URL を開いてください。');
      console.error(authorizeUrl.toString());
    }
  } else {
    console.error('以下の URL をブラウザで開いてログインしてください。');
    console.error(authorizeUrl.toString());
  }

  const authorizationCode = await callbackPromise;
  const tokens = await exchangeAuthorizationCode({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    codeVerifier: verifier,
    authorizationCode
  });

  await saveTokens(tokens);
  console.error('ログインが完了しました。');
}

async function handleStatus(flags) {
  const config = await loadConfig();
  const tokens = await loadTokens();
  const payload = {
    ok: true,
    configured: Boolean(config.clientId && config.redirectUri),
    hasRefreshToken: Boolean(tokens?.refreshToken),
    accessTokenExpiresAt: tokens?.accessTokenExpiresAt ?? null,
    configPath: CONFIG_PATH,
    tokenPath: TOKEN_PATH
  };

  if (flags.json) {
    printJson(payload);
    return;
  }

  console.log(`configured: ${payload.configured ? 'yes' : 'no'}`);
  console.log(`has_refresh_token: ${payload.hasRefreshToken ? 'yes' : 'no'}`);
  console.log(`access_token_expires_at: ${payload.accessTokenExpiresAt ?? 'n/a'}`);
  console.log(`config_path: ${payload.configPath}`);
  console.log(`token_path: ${payload.tokenPath}`);
}

async function handleNow(flags) {
  const state = await fetchPlaybackState();
  const payload = { ok: true, state };

  if (flags.json) {
    printJson(payload);
    return;
  }

  if (!state.track) {
    console.log('再生中の曲はありません。');
    return;
  }

  const artists = state.track.artists.map((artist) => artist.name).join(', ');
  console.log(`${artists} - ${state.track.name}`);
  console.log(`state: ${state.playbackState}`);
  console.log(`position_ms: ${state.positionMs}`);
  console.log(`updated_at: ${state.updatedAt}`);
}

async function handleDevices(flags) {
  const response = await spotifyApiFetch('/v1/me/player/devices');
  const devices = response.body?.devices ?? [];
  const payload = { ok: true, devices: devices.map(normalizeDevice) };

  if (flags.json) {
    printJson(payload);
    return;
  }

  for (const device of payload.devices) {
    const status = device.isActive ? 'active' : 'inactive';
    console.log(`${device.name} (${device.type}, ${status})`);
  }
}

async function handleServe(flags) {
  const port = parseNumberFlag(flags.port, DEFAULT_API_PORT, 'port');
  const pollIntervalMs = parseNumberFlag(
    flags['poll-interval-ms'],
    DEFAULT_POLL_INTERVAL_MS,
    'poll-interval-ms'
  );

  const hub = createPlaybackHub({ pollIntervalMs });
  await hub.refresh('startup');
  hub.startPolling();

  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);

      if (request.method === 'GET' && requestUrl.pathname === '/health') {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/playback/state') {
        const state = await hub.getFreshState();
        writeJson(response, 200, { ok: true, state });
        return;
      }

      if (request.method === 'GET' && requestUrl.pathname === '/events') {
        hub.attachClient(response);
        return;
      }

      writeJson(response, 404, {
        ok: false,
        error: 'not_found',
        message: '利用可能なエンドポイント: GET /health, GET /playback/state, GET /events'
      });
    } catch (error) {
      writeJson(response, 500, {
        ok: false,
        error: 'internal_error',
        message: error.message
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const shutdown = () => {
    hub.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.error(`API server listening on http://127.0.0.1:${port}`);
}

async function handlePlaybackControl(command, flags) {
  const normalizedCommand = command === 'previous' ? 'prev' : command;
  const playback = await fetchRawPlayback();
  const deviceId = await resolveControlDeviceId(playback);

  if (normalizedCommand === 'play') {
    await spotifyApiFetch('/v1/me/player/play', {
      method: 'PUT',
      body: {},
      query: { device_id: deviceId }
    });
    return printControlResult(flags, { action: 'play', message: 'Spotify を再生しました。' });
  }

  if (normalizedCommand === 'pause') {
    await spotifyApiFetch('/v1/me/player/pause', {
      method: 'PUT',
      query: { device_id: deviceId }
    });
    return printControlResult(flags, { action: 'pause', message: 'Spotify を一時停止しました。' });
  }

  const endpoint = normalizedCommand === 'next' ? '/v1/me/player/next' : '/v1/me/player/previous';
  await spotifyApiFetch(endpoint, {
    method: 'POST',
    query: { device_id: deviceId }
  });
  const message = normalizedCommand === 'next' ? '次の曲へ送りました。' : '前の曲へ戻しました。';
  return printControlResult(flags, { action: normalizedCommand, message });
}

async function handleTransfer(args, flags) {
  const deviceId = args[0];
  if (!deviceId) {
    throw new Error('transfer には device_id が必要です。`spotify-oauth devices --json` で確認してください。');
  }

  await spotifyApiFetch('/v1/me/player', {
    method: 'PUT',
    body: {
      device_ids: [deviceId],
      play: false
    }
  });
  return printControlResult(flags, {
    action: 'transfer',
    message: `Spotify の再生デバイスを切り替えました: ${deviceId}`
  });
}

async function handleSaved(flags) {
  const track = await requireCurrentTrack();
  const saved = await isTrackSaved(track);
  const payload = {
    action: 'saved',
    saved,
    track
  };

  if (flags.json) {
    printJson({ ok: true, ...payload });
    return;
  }

  const state = saved ? '保存済み' : '未保存';
  console.log(`${state}: ${formatTrack(track)}`);
}

async function handleLibrarySave(shouldSave, flags) {
  const track = await requireCurrentTrack();
  await saveTrackToLibrary(track, shouldSave);
  const message = shouldSave
    ? `現在の曲を保存しました: ${formatTrack(track)}`
    : `現在の曲の保存を解除しました: ${formatTrack(track)}`;

  return printControlResult(flags, {
    action: shouldSave ? 'like' : 'unlike',
    saved: shouldSave,
    track,
    message
  });
}

async function handleToggleLike(flags) {
  const track = await requireCurrentTrack();
  const saved = await isTrackSaved(track);
  const nextSaved = !saved;
  await saveTrackToLibrary(track, nextSaved);
  const message = nextSaved
    ? `現在の曲を保存しました: ${formatTrack(track)}`
    : `現在の曲の保存を解除しました: ${formatTrack(track)}`;

  return printControlResult(flags, {
    action: 'toggle-like',
    saved: nextSaved,
    track,
    message
  });
}

async function fetchRawPlayback() {
  const response = await spotifyApiFetch('/v1/me/player');
  return response.status === 204 ? null : response.body;
}

async function fetchPlaybackState() {
  const response = await spotifyApiFetch('/v1/me/player');

  if (response.status === 204 || response.body === null) {
    return normalizePlaybackState(null, { version: 0 });
  }

  return normalizePlaybackState(response.body, { version: 0 });
}

function createPlaybackHub({ pollIntervalMs }) {
  let version = 0;
  let currentState = null;
  let refreshPromise = null;
  const clients = new Set();
  let keepaliveTimer = null;
  let pollingTimer = null;

  const hub = {
    async refresh(reason) {
      if (refreshPromise) {
        return refreshPromise;
      }

      refreshPromise = (async () => {
        const latest = await fetchPlaybackState();
        version += 1;
        const previous = currentState;
        const nextState = attachLastKnownTrack({ ...latest, version }, previous);
        currentState = nextState;

        for (const event of detectPlaybackEvents(previous, nextState, reason)) {
          broadcastEvent(event.type, {
            reason,
            state: nextState
          });
        }

        return nextState;
      })();

      try {
        return await refreshPromise;
      } finally {
        refreshPromise = null;
      }
    },
    async getFreshState() {
      if (!currentState) {
        return hub.refresh('read-through');
      }

      const ageMs = Date.now() - Date.parse(currentState.updatedAt);
      if (ageMs >= pollIntervalMs) {
        return hub.refresh('read-through');
      }

      return currentState;
    },
    attachClient(response) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });
      response.write('\n');
      clients.add(response);

      if (!keepaliveTimer) {
        keepaliveTimer = setInterval(() => {
          for (const client of clients) {
            client.write(': keepalive\n\n');
          }
        }, 25_000);
      }

      if (currentState) {
        writeSseEvent(response, 'snapshot', {
          reason: 'connect',
          state: currentState
        });
      }

      response.on('close', () => {
        clients.delete(response);
        if (clients.size === 0 && keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      });
    },
    startPolling() {
      if (pollingTimer) {
        return;
      }

      pollingTimer = setInterval(() => {
        hub.refresh('poll').catch((error) => {
          broadcastEvent('error', {
            message: error.message
          });
        });
      }, pollIntervalMs);
    },
    stop() {
      if (pollingTimer) {
        clearInterval(pollingTimer);
      }
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
      }
      for (const client of clients) {
        client.end();
      }
      clients.clear();
    }
  };

  function broadcastEvent(type, data) {
    for (const client of clients) {
      writeSseEvent(client, type, data);
    }
  }

  return hub;
}

function detectPlaybackEvents(previous, current, reason) {
  if (!previous) {
    return [{ type: 'snapshot', reason }];
  }

  const events = [];
  if (previous.playbackState !== current.playbackState) {
    events.push({ type: current.isPlaying ? 'play' : 'pause', reason });
  }

  const previousComparableTrackId = previous.track?.id ?? previous.lastTrack?.id;
  const currentComparableTrackId = current.track?.id ?? current.lastTrack?.id;
  if (previousComparableTrackId !== currentComparableTrackId) {
    events.push({ type: 'trackChanged', reason });
  }

  if (shouldEmitPositionUpdated(previous, current)) {
    events.push({ type: 'positionUpdated', reason });
  }

  return events;
}

function shouldEmitPositionUpdated(previous, current) {
  if (!previous.track || !current.track) {
    return false;
  }

  const elapsedMs = Date.parse(current.updatedAt) - Date.parse(previous.updatedAt);
  const expectedPositionMs = previous.isPlaying
    ? previous.positionMs + Math.max(0, elapsedMs)
    : previous.positionMs;
  return Math.abs(current.positionMs - expectedPositionMs) >= POSITION_DRIFT_THRESHOLD_MS;
}

async function requireConfig() {
  const config = await loadConfig();
  if (!config.clientId || !config.redirectUri) {
    throw new Error('未設定です。先に setup --client-id --redirect-uri を実行してください。');
  }
  assertRedirectUri(config.redirectUri);
  return config;
}

async function loadConfig() {
  return readJsonFile(CONFIG_PATH, {});
}

async function saveConfig(config) {
  await ensureConfigDir();
  await saveJsonFile(CONFIG_PATH, config);
}

async function loadTokens() {
  return readJsonFile(TOKEN_PATH, null);
}

async function saveTokens(tokens) {
  await ensureConfigDir();
  await saveJsonFile(TOKEN_PATH, tokens);
}

async function ensureConfigDir() {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

async function readJsonFile(filePath, fallbackValue) {
  try {
    const text = await readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallbackValue;
    }
    throw new Error(`${filePath} を読めませんでした: ${error.message}`);
  }
}

async function saveJsonFile(filePath, value) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, json, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function getAccessToken() {
  const config = await requireConfig();
  const tokens = await loadTokens();

  if (!tokens?.refreshToken) {
    throw new Error('未ログインです。先に login を実行してください。');
  }

  const expiresAtMs = Date.parse(tokens.accessTokenExpiresAt ?? '');
  if (Number.isFinite(expiresAtMs) && expiresAtMs - TOKEN_REFRESH_SKEW_MS > Date.now()) {
    return tokens.accessToken;
  }

  const refreshedTokens = await refreshAccessToken({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: tokens.refreshToken
  });

  const nextTokens = {
    ...tokens,
    ...refreshedTokens,
    refreshToken: refreshedTokens.refreshToken ?? tokens.refreshToken
  };
  await saveTokens(nextTokens);
  return nextTokens.accessToken;
}

async function spotifyApiFetch(resourcePath, { method = 'GET', body = null, query = null, retry = true } = {}) {
  const token = await getAccessToken();
  const url = new URL(`https://api.spotify.com${resourcePath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (response.status === 401 && retry) {
    const config = await requireConfig();
    const tokens = await loadTokens();
    if (!tokens?.refreshToken) {
      throw new Error('refresh token がありません。再ログインしてください。');
    }

    const refreshedTokens = await refreshAccessToken({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: tokens.refreshToken
    });
    const nextTokens = {
      ...tokens,
      ...refreshedTokens,
      refreshToken: refreshedTokens.refreshToken ?? tokens.refreshToken
    };
    await saveTokens(nextTokens);
    return spotifyApiFetch(resourcePath, { method, body, query, retry: false });
  }

  if (response.status === 204) {
    return { status: 204, body: null };
  }

  const text = await response.text();
  const parsedBody = text ? safeJsonParse(text) : null;
  if (!response.ok) {
    const message = parsedBody?.error?.message ?? `Spotify API error (${response.status})`;
    throw new Error(message);
  }

  return {
    status: response.status,
    body: parsedBody
  };
}

async function resolveControlDeviceId(playback = null) {
  const playbackDeviceId = playback?.device?.id;
  if (playbackDeviceId) {
    return playbackDeviceId;
  }

  const response = await spotifyApiFetch('/v1/me/player/devices');
  const devices = response.body?.devices ?? [];
  const activeDevice = devices.find((device) => device?.is_active && device?.id);
  if (activeDevice) {
    return activeDevice.id;
  }

  const availableDevice = devices.find((device) => device?.id);
  if (availableDevice) {
    return availableDevice.id;
  }

  throw new Error('Spotify の再生デバイスが見つかりません。Spotify アプリか Web Player を開いてから再実行してください。');
}

async function requireCurrentTrack() {
  const playback = await fetchRawPlayback();
  const playbackTrack = normalizeTrack(playback?.item);
  if (playbackTrack?.id) {
    return playbackTrack;
  }

  const fallbackTrackId = process.env.SPOTIFY_OAUTH_TRACK_ID || process.env.SPOTIFY_CONTROL_TRACK_ID || '';
  if (fallbackTrackId) {
    const response = await spotifyApiFetch(`/v1/tracks/${encodeURIComponent(fallbackTrackId)}`);
    const track = normalizeTrack(response.body);
    if (track?.id) {
      return track;
    }
  }

  throw new Error('現在再生中の曲が見つかりません。曲を再生してから再実行してください。');
}

async function isTrackSaved(track) {
  const response = await spotifyApiFetch('/v1/me/library/contains', {
    query: { uris: libraryUri(track) }
  });
  return Array.isArray(response.body) ? Boolean(response.body[0]) : false;
}

async function saveTrackToLibrary(track, shouldSave) {
  await spotifyApiFetch('/v1/me/library', {
    method: shouldSave ? 'PUT' : 'DELETE',
    query: { uris: libraryUri(track) }
  });
}

function libraryUri(track) {
  return track.uri || `spotify:track:${track.id}`;
}

function formatTrack(track) {
  const artists = Array.isArray(track.artists)
    ? track.artists.map((artist) => artist?.name).filter(Boolean).join(', ')
    : '';
  return `${track.name || 'Unknown track'} / ${artists || 'Unknown artist'}`;
}

function printControlResult(flags, payload) {
  if (flags.json) {
    printJson({ ok: true, ...payload });
    return;
  }

  console.log(payload.message);
}

async function exchangeAuthorizationCode({
  clientId,
  clientSecret,
  redirectUri,
  codeVerifier,
  authorizationCode
}) {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: tokenRequestHeaders({ clientId, clientSecret }),
    body: new URLSearchParams({
      ...(clientSecret ? {} : { client_id: clientId }),
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    })
  });

  return handleTokenResponse(response);
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: tokenRequestHeaders({ clientId, clientSecret }),
    body: new URLSearchParams({
      ...(clientSecret ? {} : { client_id: clientId }),
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  });

  return handleTokenResponse(response);
}

function tokenRequestHeaders({ clientId, clientSecret }) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  if (clientSecret) {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers.Authorization = `Basic ${credentials}`;
  }
  return headers;
}

async function handleTokenResponse(response) {
  const text = await response.text();
  const body = text ? safeJsonParse(text) : {};
  if (!response.ok) {
    const message = body?.error_description ?? body?.error ?? `token endpoint error (${response.status})`;
    throw new Error(message);
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    scope: body.scope,
    tokenType: body.token_type,
    accessTokenExpiresAt: new Date(Date.now() + (body.expires_in * 1000)).toISOString()
  };
}

function waitForAuthorizationCode({ redirectUri, callbackPort, expectedState }) {
  const callbackUrl = new URL(redirectUri);
  const timeoutMs = 180_000;

  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      try {
        const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${callbackPort}`);
        if (requestUrl.pathname !== callbackUrl.pathname) {
          response.statusCode = 404;
          response.end('not found');
          return;
        }

        const code = requestUrl.searchParams.get('code');
        const state = requestUrl.searchParams.get('state');
        const error = requestUrl.searchParams.get('error');

        if (error) {
          response.statusCode = 400;
          response.end('Spotify login failed.');
          reject(new Error(`認可に失敗しました: ${error}`));
          server.close();
          return;
        }

        if (!code) {
          response.statusCode = 400;
          response.end('Invalid callback.');
          return;
        }

        if (state !== expectedState) {
          response.statusCode = 400;
          response.end('Invalid callback.');
          return;
        }

        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<html><body>ログインが完了しました。CLI に戻ってください。</body></html>');
        resolve(code);
        server.close();
      } catch (error) {
        reject(error);
        server.close();
      }
    });

    const timer = setTimeout(() => {
      reject(new Error('ログイン待機がタイムアウトしました。'));
      server.close();
    }, timeoutMs);

    server.once('close', () => clearTimeout(timer));
    server.once('error', reject);
    server.listen(callbackPort, '127.0.0.1');
  });
}

function normalizePlaybackState(rawPlayer, { version }) {
  if (!rawPlayer) {
    return {
      version,
      playbackState: 'idle',
      isPlaying: false,
      positionMs: 0,
      updatedAt: new Date().toISOString(),
      track: null,
      lastTrack: null,
      inactiveReason: 'no_active_device',
      device: null
    };
  }

  const track = normalizeTrack(rawPlayer.item);
  return {
    version,
    playbackState: rawPlayer.is_playing ? 'playing' : 'paused',
    isPlaying: Boolean(rawPlayer.is_playing),
    positionMs: rawPlayer.progress_ms ?? 0,
    updatedAt: new Date().toISOString(),
    track,
    lastTrack: null,
    inactiveReason: track ? null : 'no_track',
    device: normalizeDevice(rawPlayer.device)
  };
}

function attachLastKnownTrack(current, previous) {
  if (current.track) {
    return {
      ...current,
      lastTrack: null
    };
  }

  return {
    ...current,
    lastTrack: previous?.track ?? previous?.lastTrack ?? null
  };
}

function normalizeTrack(track) {
  if (!track) {
    return null;
  }

  return {
    id: track.id ?? null,
    name: track.name ?? null,
    uri: track.uri ?? null,
    durationMs: track.duration_ms ?? null,
    album: track.album
      ? {
          id: track.album.id ?? null,
          name: track.album.name ?? null,
          images: normalizeImages(track.album.images)
        }
      : null,
    artists: Array.isArray(track.artists)
      ? track.artists.map((artist) => ({
          id: artist.id ?? null,
          name: artist.name ?? null
        }))
      : []
  };
}

function normalizeImages(images) {
  if (!Array.isArray(images)) {
    return [];
  }

  return images
    .map((image) => ({
      url: image?.url ?? null,
      width: image?.width ?? null,
      height: image?.height ?? null
    }))
    .filter((image) => image.url);
}

function normalizeDevice(device) {
  if (!device) {
    return null;
  }

  return {
    id: device.id ?? null,
    isActive: Boolean(device.is_active),
    isRestricted: Boolean(device.is_restricted),
    name: device.name ?? null,
    type: device.type ?? null,
    volumePercent: device.volume_percent ?? null
  };
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function writeSseEvent(response, eventName, payload) {
  const json = JSON.stringify(payload);
  response.write(`id: ${payload.state?.version ?? Date.now()}\n`);
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${json}\n\n`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function openUrl(url) {
  const commands = process.platform === 'darwin'
    ? [['open', [url]]]
    : process.platform === 'win32'
      ? [['cmd', ['/c', 'start', '', url]]]
      : [['xdg-open', [url]]];

  for (const [command, args] of commands) {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

function readStringFlag(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('必須オプションが不足しています。');
  }
  return value;
}

function readOptionalStringFlag(value) {
  if (value === undefined || value === false) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('任意オプションの値が不正です。');
  }
  return value;
}

function parseNumberFlag(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} は正の整数で指定してください。`);
  }
  return parsed;
}

function resolveCallbackPort(redirectUri, rawCallbackPort) {
  if (rawCallbackPort !== undefined) {
    return parseNumberFlag(rawCallbackPort, DEFAULT_CALLBACK_PORT, 'callback-port');
  }

  const url = new URL(redirectUri);
  if (url.port) {
    return Number(url.port);
  }

  return DEFAULT_CALLBACK_PORT;
}

function assertRedirectUri(redirectUri) {
  let url;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new Error('redirect_uri は絶対 URL で指定してください。');
  }

  if (!url.pathname) {
    throw new Error('redirect_uri に path が必要です。');
  }

  if (url.protocol !== 'https:' && !url.port) {
    throw new Error('redirect_uri に port が必要です。');
  }
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
