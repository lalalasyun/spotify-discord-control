import nacl from 'tweetnacl';

const DISCORD_API = 'https://discord.com/api/v10';
const SPOTIFY_ACCOUNTS_API = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API = 'https://api.spotify.com';
const TOKEN_KEY = 'spotify:tokens';
const MESSAGE_ID_KEY = 'discord:last-message-id';
const TRACK_ID_KEY = 'discord:last-track-id';
const CONTROL_SYNC_PENDING_KEY = 'discord:control-sync-pending';
const BUILD_ID = 'issue19-no-overwrite-20260603-2';
const COMPONENT_PREFIX = 'spotify_worker:v1:';
const TOKEN_REFRESH_SKEW_MS = 60_000;
const CONTROL_SYNC_PENDING_TTL_SECONDS = 60;
const PLAYBACK_CONTROL_RETRY_DELAYS_MS = [250, 750, 1_500, 3_000];
const SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
  'user-library-read',
  'user-library-modify',
];
const PLAYBACK_ACTIONS = new Set(['prev', 'play', 'pause', 'next']);
const CONTROL_ACTIONS = new Set([...PLAYBACK_ACTIONS, 'like']);
const LEGACY_SECRET_VALUE_PATTERN = /^[A-Za-z0-9_-]{20,512}$/;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, build: BUILD_ID });
      }

      if (request.method === 'GET' && url.pathname === '/spotify/login') {
        return Response.redirect(await createAuthorizeUrl(env, request), 302);
      }

      if (request.method === 'GET' && url.pathname === redirectPath(env)) {
        return handleSpotifyCallback(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/discord/interactions') {
        return handleDiscordInteraction(request, env, ctx);
      }

      return json({ ok: false, error: 'not_found' }, 404);
    } catch (error) {
      return json({ ok: false, error: 'internal_error', message: errorMessage(error) }, 500);
    }
  },

  async scheduled(_event, env, _ctx) {
    if (!env.DISCORD_CHANNEL_ID || !env.DISCORD_BOT_TOKEN) {
      return;
    }

    try {
      if (await hasPendingControlSync(env)) {
        logWorkerEvent('spotify_scheduled_skip', {
          reason: 'control_sync_pending',
        });
        return;
      }
      const state = await fetchPlaybackState(env);
      await upsertPlaybackMessage(
        env,
        await formatPlaybackMessage(env, 'cron', state),
        displayTrack(state)?.id || 'none',
        { source: 'cron' },
      );
    } catch (error) {
      console.error(`scheduled refresh failed: ${errorMessage(error)}`);
    }
  },
};

async function handleDiscordInteraction(request, env, ctx) {
  const body = await request.text();
  if (!verifyDiscordRequest(request, env, body)) {
    return new Response('invalid request signature', { status: 401 });
  }

  try {
    const interaction = JSON.parse(body);
    if (interaction.type === 1) {
      return json({ type: 1 });
    }

    if (interaction.type === 2) {
      return await handleApplicationCommand(interaction, env, request);
    }

    if (interaction.type === 3) {
      return await handleComponentInteraction(interaction, env, ctx);
    }
  } catch (error) {
    return interactionMessage(errorMessage(error), true);
  }

  return interactionMessage('Unsupported interaction.', true);
}

async function handleApplicationCommand(interaction, env, request) {
  const subcommand = applicationCommandSubcommand(interaction);

  if (subcommand === 'login') {
    const authorizeUrl = await createAuthorizeUrl(env, request);
    return interactionMessage(`Open this Spotify authorization URL:\n${authorizeUrl}`, true);
  }

  if (subcommand === 'card' || subcommand === 'now') {
    const state = await fetchPlaybackState(env);
    const message = await formatPlaybackMessage(env, subcommand, state);
    if (subcommand === 'card' && env.DISCORD_CHANNEL_ID && env.DISCORD_BOT_TOKEN) {
      const result = await upsertPlaybackMessage(env, message, displayTrack(state)?.id || 'none', {
        source: 'command',
      });
      return interactionMessage(`Playback card ${result.action}.`, true);
    }
    return json({ type: 4, data: withAllowedMentions(message) });
  }

  if (PLAYBACK_ACTIONS.has(subcommand)) {
    await controlPlayback(env, subcommand);
    const state = await fetchPlaybackState(env);
    return json({
      type: 4,
      data: withAllowedMentions(await formatPlaybackMessage(env, 'control', state)),
    });
  }

  if (subcommand === 'like') {
    const result = await toggleCurrentTrackSaved(env);
    const state = await fetchPlaybackState(env);
    return json({
      type: 4,
      data: withAllowedMentions({
        ...formatMessage(result.saved ? 'liked' : 'unliked', state),
        components: buildControls(state, result.saved),
      }),
    });
  }

  return interactionMessage(`Unknown subcommand: ${subcommand}`, true);
}

function applicationCommandSubcommand(interaction) {
  return interaction?.data?.options?.[0]?.name || 'card';
}

async function handleComponentInteraction(interaction, env, ctx) {
  const action = actionFromCustomId(interaction?.data?.custom_id || '');
  if (!CONTROL_ACTIONS.has(action)) {
    logWorkerEvent('spotify_component_unknown_control', {
      customId: interaction?.data?.custom_id || '',
    });
    return interactionMessage('Unknown control.', true);
  }

  const messageId = interaction?.message?.id || '';
  const lastMessageId = await env.SPOTIFY_TOKENS.get(MESSAGE_ID_KEY);
  const isStale = Boolean(messageId && lastMessageId && messageId !== lastMessageId);
  logWorkerEvent('spotify_component_received', {
    action,
    messageId,
    lastMessageId,
    messageTrackId: messageTrackIdFromInteraction(interaction),
    isStale,
  });
  if (isStale && PLAYBACK_ACTIONS.has(action)) {
    logWorkerEvent('spotify_component_branch', {
      action,
      messageId,
      branch: 'stale_disable_clicked_card',
    });
    return json({
      type: 7,
      data: withAllowedMentions(disablePlaybackButtons(interaction.message)),
    });
  }

  if (action === 'like') {
    const result = await toggleCurrentTrackSaved(env);
    const nextMessage = updateLikeButton(interaction.message, result.saved);
    logWorkerEvent('spotify_component_branch', {
      action,
      messageId,
      branch: 'like_update_clicked_card',
      saved: result.saved,
      trackId: result.track?.id || '',
    });
    ctx.waitUntil(refreshStoredCard(env));
    return json({ type: 7, data: withAllowedMentions(nextMessage) });
  }

  const state = await fetchPlaybackState(env);
  const messageTrackId = messageTrackIdFromInteraction(interaction);
  const currentTrackId = displayTrack(state)?.id || '';
  logWorkerEvent('spotify_component_playback_state', {
    action,
    messageId,
    messageTrackId,
    currentTrackId,
    playbackState: state?.playbackState || '',
  });
  if (messageTrackId && currentTrackId && messageTrackId !== currentTrackId) {
    logWorkerEvent('spotify_component_branch', {
      action,
      messageId,
      branch: 'track_mismatch_disable_clicked_card',
      messageTrackId,
      currentTrackId,
    });
    ctx.waitUntil(refreshStoredCard(env, state));
    return json({
      type: 7,
      data: withAllowedMentions(disablePlaybackButtons(interaction.message)),
    });
  }

  let nextState = state;
  let eventType = 'control';
  try {
    await controlPlayback(env, action, state);
    nextState = await fetchPlaybackState(env);
  } catch (error) {
    logWorkerEvent('spotify_component_control_failed', {
      action,
      messageId,
      error: errorMessage(error),
    });
    console.error(`playback control failed: ${errorMessage(error)}`);
    nextState = await fetchPlaybackState(env).catch(() => state);
    eventType = 'control failed';
  }

  const previousTrackId = currentTrackId || 'none';
  if (eventType === 'control' && (action === 'next' || action === 'prev')) {
    if (env.DISCORD_CHANNEL_ID && env.DISCORD_BOT_TOKEN) {
      await markControlSyncPending(env, {
        action,
        previousTrackId,
        nextTrackId: displayTrack(nextState)?.id || 'none',
      });
      logWorkerEvent('spotify_component_branch', {
        action,
        messageId,
        branch: 'queue_new_card_for_next_prev',
        previousTrackId,
        nextTrackId: displayTrack(nextState)?.id || 'none',
      });
      ctx.waitUntil(upsertPlaybackMessageAfterControl(env, nextState, previousTrackId, eventType));
    } else {
      logWorkerEvent('spotify_component_branch', {
        action,
        messageId,
        branch: 'disable_clicked_card_without_discord_config',
        previousTrackId,
      });
    }
    return json({
      type: 7,
      data: withAllowedMentions(disablePlaybackButtons(interaction.message)),
    });
  }

  const nextTrackId = displayTrack(nextState)?.id || 'none';
  if (
    eventType === 'control' &&
    nextTrackId !== previousTrackId &&
    env.DISCORD_CHANNEL_ID &&
    env.DISCORD_BOT_TOKEN
  ) {
    await markControlSyncPending(env, {
      action,
      previousTrackId,
      nextTrackId,
    });
    logWorkerEvent('spotify_component_branch', {
      action,
      messageId,
      branch: 'queue_new_card_for_changed_track',
      previousTrackId,
      nextTrackId,
    });
    ctx.waitUntil(upsertPlaybackMessageAfterControl(env, nextState, previousTrackId, eventType));
    return json({
      type: 7,
      data: withAllowedMentions(disablePlaybackButtons(interaction.message)),
    });
  }

  logWorkerEvent('spotify_component_branch', {
    action,
    messageId,
    branch: 'update_clicked_card',
    previousTrackId,
    nextTrackId,
    eventType,
  });
  return json({
    type: 7,
    data: withAllowedMentions(await formatPlaybackMessage(env, eventType, nextState)),
  });
}

async function upsertPlaybackMessageAfterControl(env, initialState, previousTrackId, eventType) {
  try {
    let state = initialState;
    let trackId = displayTrack(state)?.id || 'none';
    const retryDelays = playbackControlRetryDelays(env);
    logWorkerEvent('spotify_control_upsert_start', {
      eventType,
      previousTrackId,
      initialTrackId: trackId,
      retryCount: retryDelays.length,
    });

    for (const [attemptIndex, retryDelay] of retryDelays.entries()) {
      if (trackId !== previousTrackId) break;
      await sleep(retryDelay);
      state = await fetchPlaybackState(env);
      trackId = displayTrack(state)?.id || 'none';
      logWorkerEvent('spotify_control_upsert_retry', {
        eventType,
        previousTrackId,
        trackId,
        attempt: attemptIndex + 1,
        delayMs: retryDelay,
      });
    }

    const result = await upsertPlaybackMessage(
      env,
      await formatPlaybackMessage(env, eventType, state),
      trackId,
      { source: 'control' },
    );
    logWorkerEvent('spotify_control_upsert_result', {
      eventType,
      previousTrackId,
      trackId,
      action: result.action,
      messageId: result.messageId,
    });
  } finally {
    await clearControlSyncPending(env);
  }
}

function playbackControlRetryDelays(env) {
  if (!env.PLAYBACK_CONTROL_RETRY_DELAYS_MS) return PLAYBACK_CONTROL_RETRY_DELAYS_MS;

  const parsed = String(env.PLAYBACK_CONTROL_RETRY_DELAYS_MS)
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return parsed.length ? parsed : PLAYBACK_CONTROL_RETRY_DELAYS_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hasPendingControlSync(env) {
  return Boolean(await env.SPOTIFY_TOKENS.get(CONTROL_SYNC_PENDING_KEY));
}

async function markControlSyncPending(env, details) {
  await env.SPOTIFY_TOKENS.put(
    CONTROL_SYNC_PENDING_KEY,
    JSON.stringify({
      ...details,
      createdAt: new Date().toISOString(),
    }),
    { expirationTtl: CONTROL_SYNC_PENDING_TTL_SECONDS },
  );
  logWorkerEvent('spotify_control_sync_pending_set', details);
}

async function clearControlSyncPending(env) {
  await env.SPOTIFY_TOKENS.delete(CONTROL_SYNC_PENDING_KEY);
  logWorkerEvent('spotify_control_sync_pending_cleared');
}

function verifyDiscordRequest(request, env, body) {
  const signature = request.headers.get('x-signature-ed25519') || '';
  const timestamp = request.headers.get('x-signature-timestamp') || '';
  if (!signature || !timestamp || !env.DISCORD_PUBLIC_KEY) {
    return false;
  }

  const signatureBytes = hexToBytes(signature);
  const publicKeyBytes = hexToBytes(env.DISCORD_PUBLIC_KEY);
  if (signatureBytes.length !== 64 || publicKeyBytes.length !== 32) {
    return false;
  }

  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(`${timestamp}${body}`),
      signatureBytes,
      publicKeyBytes,
    );
  } catch {
    return false;
  }
}

async function createAuthorizeUrl(env, request) {
  requireEnv(env, 'SPOTIFY_CLIENT_ID');
  requireKv(env);

  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = await sha256Base64Url(verifier);
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const authorizeUrl = new URL('https://accounts.spotify.com/authorize');
  const redirectUri = spotifyRedirectUri(env, request);

  await env.SPOTIFY_TOKENS.put(
    `spotify:oauth:state:${state}`,
    JSON.stringify({
      verifier,
      redirectUri,
      createdAt: new Date().toISOString(),
    }),
    { expirationTtl: 600 },
  );

  authorizeUrl.search = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: SCOPES.join(' '),
  }).toString();

  return authorizeUrl.toString();
}

async function handleSpotifyCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) return new Response(`Spotify authorization failed: ${error}`, { status: 400 });
  if (!code || !state) return new Response('Missing code or state.', { status: 400 });

  const stateKey = `spotify:oauth:state:${state}`;
  const storedState = await loadOAuthState(env, stateKey, request);
  if (!storedState?.verifier || !storedState?.redirectUri) {
    return new Response('OAuth state expired or invalid. Run /spotify login again.', {
      status: 400,
    });
  }

  const tokens = await exchangeAuthorizationCode(env, {
    code,
    redirectUri: storedState.redirectUri,
    codeVerifier: storedState.verifier,
  });
  await saveTokens(env, tokens);
  await env.SPOTIFY_TOKENS.delete(stateKey);

  return new Response('Spotify authorization complete. You can return to Discord.', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

async function loadOAuthState(env, stateKey, request) {
  const value = await env.SPOTIFY_TOKENS.get(stateKey);
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return parsed;
    if (typeof parsed === 'string' && LEGACY_SECRET_VALUE_PATTERN.test(parsed)) {
      return {
        verifier: parsed,
        redirectUri: spotifyRedirectUri(env, request),
      };
    }
  } catch {
    if (LEGACY_SECRET_VALUE_PATTERN.test(value)) {
      return {
        verifier: value,
        redirectUri: spotifyRedirectUri(env, request),
      };
    }
    console.error('OAuth state KV value is not valid JSON; ignoring it.');
  }

  return null;
}

async function exchangeAuthorizationCode(env, { code, redirectUri, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  if (!env.SPOTIFY_CLIENT_SECRET) body.set('client_id', env.SPOTIFY_CLIENT_ID);

  const payload = await spotifyTokenRequest(env, body);
  return normalizeTokens(payload, null);
}

async function refreshAccessToken(env, tokens) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
  });
  if (!env.SPOTIFY_CLIENT_SECRET) body.set('client_id', env.SPOTIFY_CLIENT_ID);

  const payload = await spotifyTokenRequest(env, body);
  const nextTokens = normalizeTokens(payload, tokens.refreshToken);
  await saveTokens(env, nextTokens);
  return nextTokens;
}

async function spotifyTokenRequest(env, body) {
  const response = await fetch(SPOTIFY_ACCOUNTS_API, {
    method: 'POST',
    headers: tokenRequestHeaders(env),
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Spotify token request failed: ${response.status} ${JSON.stringify(payload).slice(0, 300)}`,
    );
  }
  return payload;
}

function tokenRequestHeaders(env) {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (env.SPOTIFY_CLIENT_SECRET) {
    headers.Authorization = `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`;
  }
  return headers;
}

function normalizeTokens(payload, fallbackRefreshToken) {
  const refreshToken = payload.refresh_token || fallbackRefreshToken;
  if (!payload.access_token || !refreshToken) {
    throw new Error('Spotify token response did not include required tokens.');
  }
  return {
    accessToken: payload.access_token,
    refreshToken,
    tokenType: payload.token_type || 'Bearer',
    scope: payload.scope || '',
    accessTokenExpiresAt: new Date(
      Date.now() + Number(payload.expires_in || 3600) * 1000,
    ).toISOString(),
  };
}

async function getAccessToken(env) {
  requireEnv(env, 'SPOTIFY_CLIENT_ID');
  requireKv(env);
  const tokens = await loadStoredTokens(env);
  if (!tokens?.refreshToken) {
    throw new Error('Spotify is not authorized. Run /spotify login first.');
  }

  if (Date.parse(tokens.accessTokenExpiresAt || '') - TOKEN_REFRESH_SKEW_MS > Date.now()) {
    return tokens.accessToken;
  }

  const refreshed = await refreshAccessToken(env, tokens);
  return refreshed.accessToken;
}

async function saveTokens(env, tokens) {
  await env.SPOTIFY_TOKENS.put(TOKEN_KEY, JSON.stringify(tokens));
}

async function loadStoredTokens(env) {
  const value = await env.SPOTIFY_TOKENS.get(TOKEN_KEY);
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'string' && LEGACY_SECRET_VALUE_PATTERN.test(parsed)) {
      return { refreshToken: parsed };
    }
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    if (LEGACY_SECRET_VALUE_PATTERN.test(value)) {
      return { refreshToken: value };
    }
    console.error('Spotify token KV value is not valid JSON; treating it as unauthorized.');
    return null;
  }
}

async function spotifyApiFetch(env, endpoint, options: any = {}) {
  const url = new URL(`${SPOTIFY_API}${endpoint}`);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== '')
      url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${await getAccessToken(env)}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) {
    return { status: response.status, body: null };
  }

  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  const body = text ? (contentType.includes('application/json') ? JSON.parse(text) : text) : null;
  if (!response.ok) {
    throw new Error(`Spotify ${endpoint} failed: ${response.status} ${text.slice(0, 300)}`);
  }
  return { status: response.status, body };
}

async function fetchPlaybackState(env) {
  const response = await spotifyApiFetch(env, '/v1/me/player');
  return normalizePlaybackState(response.body);
}

async function controlPlayback(env, action, playbackState = null) {
  const playback = playbackState?.raw || (await spotifyApiFetch(env, '/v1/me/player')).body;
  const deviceId = await resolveControlDeviceId(env, playback);

  if (action === 'play') {
    await spotifyApiFetch(env, '/v1/me/player/play', {
      method: 'PUT',
      query: { device_id: deviceId },
      body: {},
    });
    return;
  }

  if (action === 'pause') {
    await spotifyApiFetch(env, '/v1/me/player/pause', {
      method: 'PUT',
      query: { device_id: deviceId },
    });
    return;
  }

  await spotifyApiFetch(env, action === 'next' ? '/v1/me/player/next' : '/v1/me/player/previous', {
    method: 'POST',
    query: { device_id: deviceId },
  });
}

async function resolveControlDeviceId(env, playback) {
  if (playback?.device?.id) return playback.device.id;

  const devices = (await spotifyApiFetch(env, '/v1/me/player/devices')).body?.devices || [];
  const active = devices.find((device) => device.is_active);
  if (active?.id) return active.id;
  const firstAvailable = devices.find((device) => device.id);
  if (firstAvailable?.id) return firstAvailable.id;
  throw new Error('No Spotify device is available. Open Spotify on one device first.');
}

async function toggleCurrentTrackSaved(env) {
  const state = await fetchPlaybackState(env);
  const track = displayTrack(state);
  if (!track?.id) throw new Error('No current track is available.');
  const uri = `spotify:track:${track.id}`;

  const saved =
    (
      await spotifyApiFetch(env, '/v1/me/library/contains', {
        query: { uris: uri },
      })
    ).body?.[0] === true;
  const nextSaved = !saved;
  await spotifyApiFetch(env, '/v1/me/library', {
    method: nextSaved ? 'PUT' : 'DELETE',
    query: { uris: uri },
  });
  return { saved: nextSaved, track };
}

function normalizePlaybackState(raw) {
  if (!raw) {
    return {
      playbackState: 'inactive',
      isPlaying: false,
      positionMs: 0,
      progressMs: 0,
      track: null,
      lastTrack: null,
      device: null,
      raw: null,
      updatedAt: new Date().toISOString(),
    };
  }

  const item = raw.item && raw.item.type === 'track' ? raw.item : null;
  return {
    playbackState: raw.is_playing ? 'playing' : 'paused',
    isPlaying: Boolean(raw.is_playing),
    positionMs: raw.progress_ms || 0,
    progressMs: raw.progress_ms || 0,
    track: normalizeTrack(item),
    lastTrack: normalizeTrack(item),
    device: raw.device
      ? {
          id: raw.device.id || '',
          name: raw.device.name || 'unknown device',
          type: raw.device.type || 'unknown',
          isActive: Boolean(raw.device.is_active),
        }
      : null,
    raw,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeTrack(track) {
  if (!track) return null;
  return {
    id: track.id || '',
    name: track.name || 'Unknown track',
    durationMs: track.duration_ms || 0,
    artists: Array.isArray(track.artists)
      ? track.artists.map((artist) => ({ name: artist.name || 'Unknown artist' }))
      : [],
    album: {
      name: track.album?.name || 'Unknown album',
      images: Array.isArray(track.album?.images) ? track.album.images : [],
    },
  };
}

function formatMessage(eventType, state) {
  const track = displayTrack(state) || {};
  const album = track.album?.name || 'Unknown album';
  const device = state?.device?.name || 'unknown device';
  const status = state?.playbackState || (state?.isPlaying ? 'playing' : 'paused');
  const position = `${formatMs(state?.positionMs || state?.progressMs || 0)} / ${formatMs(track.durationMs || 0)}`;
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
    footer: { text: `${eventType} | worker` },
    timestamp: state?.updatedAt || undefined,
  };
  if (artworkUrl) embed.image = { url: artworkUrl };

  return {
    content: '',
    embeds: [embed],
    components: buildControls(state),
  };
}

async function formatPlaybackMessage(env, eventType, state) {
  const saved = await fetchTrackSaved(env, state);
  return {
    ...formatMessage(eventType, state),
    components: buildControls(state, saved),
  };
}

async function fetchTrackSaved(env, state) {
  const track = displayTrack(state);
  if (!track?.id) return null;
  try {
    const uri = `spotify:track:${track.id}`;
    const response = await spotifyApiFetch(env, '/v1/me/library/contains', {
      query: { uris: uri },
    });
    return response.body?.[0] === true;
  } catch (error) {
    console.error(`saved state check failed: ${errorMessage(error)}`);
    return null;
  }
}

function buildControls(state, saved = null) {
  const toggleAction = state?.isPlaying ? 'pause' : 'play';
  const toggleEmoji = state?.isPlaying ? '⏸️' : '▶️';
  const likeDisabled = !displayTrack(state)?.id;

  return [
    {
      type: 1,
      components: [
        { type: 2, custom_id: `${COMPONENT_PREFIX}prev`, style: 2, emoji: { name: '⏮️' } },
        {
          type: 2,
          custom_id: `${COMPONENT_PREFIX}${toggleAction}`,
          style: state?.isPlaying ? 2 : 3,
          emoji: { name: toggleEmoji },
        },
        { type: 2, custom_id: `${COMPONENT_PREFIX}next`, style: 2, emoji: { name: '⏭️' } },
        {
          type: 2,
          custom_id: `${COMPONENT_PREFIX}like`,
          style: saved === true ? 3 : 2,
          emoji: { name: saved === true ? '✔️' : '➕' },
          disabled: likeDisabled,
        },
      ],
    },
  ];
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

function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--:--';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function actionFromCustomId(customId) {
  return customId.startsWith(COMPONENT_PREFIX) ? customId.slice(COMPONENT_PREFIX.length) : '';
}

function messageTrackIdFromInteraction(interaction) {
  const url = interaction?.message?.embeds?.[0]?.url || '';
  return trackIdFromSpotifyUrl(url);
}

function trackIdFromSpotifyUrl(url) {
  const match = String(url).match(/open\.spotify\.com\/track\/([^/?#]+)/);
  return match?.[1] || '';
}

function cleanMessage(message) {
  return {
    content: message?.content || '',
    embeds: Array.isArray(message?.embeds) ? message.embeds : [],
    components: Array.isArray(message?.components) ? message.components : [],
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
            return PLAYBACK_ACTIONS.has(action) ? { ...component, disabled: true } : component;
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
            return { ...component, style: saved ? 3 : 2, emoji: { name: saved ? '✔️' : '➕' } };
          })
        : row?.components,
    })),
  };
}

async function refreshStoredCard(env, state = null) {
  if (!env.DISCORD_CHANNEL_ID || !env.DISCORD_BOT_TOKEN) return;
  state ??= await fetchPlaybackState(env);
  logWorkerEvent('spotify_refresh_stored_card', {
    trackId: displayTrack(state)?.id || 'none',
  });
  await upsertPlaybackMessage(
    env,
    await formatPlaybackMessage(env, 'refresh', state),
    displayTrack(state)?.id || 'none',
    { source: 'refresh' },
  );
}

async function upsertPlaybackMessage(env, message, trackId, options = { source: 'unknown' }) {
  const source = options.source || 'unknown';
  const lastMessageId = await env.SPOTIFY_TOKENS.get(MESSAGE_ID_KEY);
  const lastTrackId = await env.SPOTIFY_TOKENS.get(TRACK_ID_KEY);
  const snapshot = { messageId: lastMessageId, trackId: lastTrackId };
  logWorkerEvent('spotify_card_upsert_start', {
    source,
    trackId,
    lastMessageId,
    lastTrackId,
  });

  if (source === 'cron' && (await hasPendingControlSync(env))) {
    logWorkerEvent('spotify_card_upsert_skipped', {
      source,
      reason: 'control_sync_pending',
      trackId,
      lastMessageId,
      lastTrackId,
    });
    return { action: 'skipped_pending', messageId: lastMessageId };
  }

  if (source === 'cron' && (await staleKvSnapshot(env, snapshot)).changed) {
    logWorkerEvent('spotify_card_upsert_skipped', {
      source,
      reason: 'stale_snapshot_before_discord_write',
      trackId,
      lastMessageId,
      lastTrackId,
    });
    return { action: 'stale_skipped', messageId: lastMessageId };
  }

  if (
    lastMessageId &&
    lastTrackId === trackId &&
    (await editMessage(env, lastMessageId, message))
  ) {
    if (source === 'cron') {
      const stale = await staleKvSnapshot(env, snapshot);
      if (stale.changed) {
        await disableStaleCronMessage(env, lastMessageId, message, {
          trackId,
          lastMessageId,
          lastTrackId,
          currentMessageId: stale.currentMessageId,
          currentTrackId: stale.currentTrackId,
        });
        return { action: 'stale_skipped', messageId: stale.currentMessageId || lastMessageId };
      }
    }
    logWorkerEvent('spotify_card_upsert_result', {
      source,
      action: 'edited',
      trackId,
      messageId: lastMessageId,
    });
    return { action: 'edited', messageId: lastMessageId };
  }

  const createdMessage = await discordRequest(
    env,
    'POST',
    `/channels/${env.DISCORD_CHANNEL_ID}/messages`,
    message,
  );
  if (lastMessageId && lastMessageId !== createdMessage.id) {
    const previous = await fetchMessage(env, lastMessageId);
    if (!previous?.unavailable) {
      const disabled = await editMessage(
        env,
        lastMessageId,
        disablePlaybackButtons(previous),
      ).catch((error) => {
        logWorkerEvent('spotify_card_disable_previous_failed', {
          messageId: lastMessageId,
          error: errorMessage(error),
        });
        return false;
      });
      logWorkerEvent('spotify_card_disable_previous_result', {
        source,
        previousMessageId: lastMessageId,
        disabled,
      });
    } else {
      logWorkerEvent('spotify_card_disable_previous_skipped', {
        previousMessageId: lastMessageId,
        status: previous?.status,
      });
    }
  }

  if (source === 'cron') {
    const stale = await staleKvSnapshot(env, snapshot);
    if (stale.changed) {
      await disableStaleCronMessage(env, createdMessage.id, message, {
        trackId,
        lastMessageId,
        lastTrackId,
        currentMessageId: stale.currentMessageId,
        currentTrackId: stale.currentTrackId,
      });
      return { action: 'stale_skipped', messageId: stale.currentMessageId || createdMessage.id };
    }
  }

  await env.SPOTIFY_TOKENS.put(MESSAGE_ID_KEY, createdMessage.id);
  await env.SPOTIFY_TOKENS.put(TRACK_ID_KEY, trackId);
  logWorkerEvent('spotify_card_upsert_result', {
    source,
    action: 'posted',
    trackId,
    messageId: createdMessage.id,
    previousMessageId: lastMessageId,
  });
  return { action: 'posted', messageId: createdMessage.id };
}

async function staleKvSnapshot(env, snapshot) {
  const currentMessageId = await env.SPOTIFY_TOKENS.get(MESSAGE_ID_KEY);
  const currentTrackId = await env.SPOTIFY_TOKENS.get(TRACK_ID_KEY);
  return {
    changed: currentMessageId !== snapshot.messageId || currentTrackId !== snapshot.trackId,
    currentMessageId,
    currentTrackId,
  };
}

async function disableStaleCronMessage(env, messageId, message, details) {
  const disabled = await editMessage(env, messageId, disablePlaybackButtons(message)).catch(
    (error) => {
      logWorkerEvent('spotify_card_stale_cron_disable_failed', {
        source: 'cron',
        messageId,
        error: errorMessage(error),
        ...details,
      });
      return false;
    },
  );
  logWorkerEvent('spotify_card_upsert_stale_write_skipped', {
    source: 'cron',
    messageId,
    disabled,
    ...details,
  });
}

async function editMessage(env, messageId, message) {
  const result = await discordRequest(
    env,
    'PATCH',
    `/channels/${env.DISCORD_CHANNEL_ID}/messages/${messageId}`,
    message,
    [403, 404],
  );
  logWorkerEvent('spotify_discord_message_edit', {
    messageId,
    status: result?.status || 200,
    unavailable: Boolean(result?.unavailable),
  });
  return !result?.unavailable;
}

async function fetchMessage(env, messageId) {
  const result = await discordRequest(
    env,
    'GET',
    `/channels/${env.DISCORD_CHANNEL_ID}/messages/${messageId}`,
    null,
    [403, 404],
  );
  logWorkerEvent('spotify_discord_message_fetch', {
    messageId,
    status: result?.status || 200,
    unavailable: Boolean(result?.unavailable),
  });
  return result;
}

async function discordRequest(env, method, endpoint, payload = null, softStatuses = []) {
  const response = await fetch(`${DISCORD_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: payload ? JSON.stringify(withAllowedMentions(payload)) : undefined,
  });

  if (softStatuses.includes(response.status)) {
    logWorkerEvent('spotify_discord_request_soft_status', {
      method,
      endpoint: sanitizeDiscordEndpoint(endpoint),
      status: response.status,
    });
    return { unavailable: true, status: response.status };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    logWorkerEvent('spotify_discord_request_failed', {
      method,
      endpoint: sanitizeDiscordEndpoint(endpoint),
      status: response.status,
    });
    throw new Error(
      `Discord ${method} ${endpoint} failed: ${response.status} ${body.slice(0, 300)}`,
    );
  }

  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function interactionMessage(content, ephemeral = false) {
  return json({
    type: 4,
    data: {
      content,
      flags: ephemeral ? 64 : undefined,
      allowed_mentions: { parse: [] },
    },
  });
}

function withAllowedMentions(message) {
  return {
    ...message,
    allowed_mentions: { parse: [] },
  };
}

function spotifyRedirectUri(env, request) {
  if (env.SPOTIFY_REDIRECT_URI) return env.SPOTIFY_REDIRECT_URI;
  const baseUrl = (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/+$/, '');
  return `${baseUrl}${redirectPath(env)}`;
}

function redirectPath(env) {
  return env.SPOTIFY_REDIRECT_PATH || '/spotify/callback';
}

function requireEnv(env, key) {
  if (!env[key]) throw new Error(`${key} is required.`);
}

function requireKv(env) {
  if (!env.SPOTIFY_TOKENS) throw new Error('SPOTIFY_TOKENS KV binding is required.');
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function logWorkerEvent(event, details: Record<string, unknown> = {}) {
  const payload = {
    event,
    build: BUILD_ID,
    ...sanitizeLogDetails(details),
  };
  console.log(JSON.stringify(payload));
}

function sanitizeLogDetails(details) {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [key, sanitizeLogValue(value)]),
  );
}

function sanitizeLogValue(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return value.slice(0, 300);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item));
  if (typeof value === 'object') return sanitizeLogDetails(value);
  return String(value).slice(0, 300);
}

function sanitizeDiscordEndpoint(endpoint) {
  return String(endpoint).replace(
    /\/channels\/([^/]+)\/messages\/([^/]+)/,
    '/channels/$1/messages/:id',
  );
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) {
    return new Uint8Array();
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}
