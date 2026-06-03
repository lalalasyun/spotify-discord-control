import { test } from 'bun:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import worker from '../worker/src/index';

const keyPair = nacl.sign.keyPair();

class MemoryKv {
  values: Map<string, string>;

  constructor() {
    this.values = new Map();
  }

  async get(key: string, type = 'text') {
    const value = this.values.get(key) ?? null;
    if (value === null) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }

  async delete(key: string) {
    this.values.delete(key);
  }
}

const ctx = {
  waitUntil() {},
};

function testEnv() {
  return {
    SPOTIFY_CLIENT_ID: 'spotify-client-id',
    DISCORD_PUBLIC_KEY: bytesToHex(keyPair.publicKey),
    PUBLIC_BASE_URL: 'https://spotify-discord-control.example.workers.dev',
    SPOTIFY_TOKENS: new MemoryKv(),
  };
}

test('health endpoint returns ok', async () => {
  const env = testEnv();
  const response = await worker.fetch(new Request('https://example.test/health'), env, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    build: 'issue19-no-overwrite-20260603-2',
  });
});

test('Discord ping validates signature and returns pong', async () => {
  const env = testEnv();
  const response = await worker.fetch(signedInteractionRequest({ type: 1 }), env, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 1 });
});

test('invalid Discord signature returns 401', async () => {
  const env = testEnv();
  const response = await worker.fetch(
    new Request('https://example.test/discord/interactions', {
      method: 'POST',
      headers: {
        'x-signature-ed25519': '00',
        'x-signature-timestamp': '123',
      },
      body: JSON.stringify({ type: 1 }),
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 401);
});

test('/spotify login returns an authorization URL', async () => {
  const env = testEnv();
  const response = await worker.fetch(
    signedInteractionRequest({
      type: 2,
      data: {
        name: 'spotify',
        options: [{ type: 1, name: 'login' }],
      },
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.type, 4);
  assert.equal(payload.data.flags, 64);
  assert.match(payload.data.content, /https:\/\/accounts\.spotify\.com\/authorize/);
  assert.match(payload.data.content, /code_challenge_method=S256/);
});

test('Spotify callback accepts legacy raw OAuth verifier state', async () => {
  const env = testEnv();
  const state = 'state-value';
  await env.SPOTIFY_TOKENS.put(`spotify:oauth:state:${state}`, 'Sbw43bbzaH_legacyRawVerifierValue');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.href, 'https://accounts.spotify.com/api/token');
    assert.equal(
      (init?.body as URLSearchParams).get('code_verifier'),
      'Sbw43bbzaH_legacyRawVerifierValue',
    );
    assert.equal(
      (init?.body as URLSearchParams).get('redirect_uri'),
      'https://spotify-discord-control.example.workers.dev/spotify/callback',
    );
    return jsonResponse({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
    });
  }) as typeof fetch;

  try {
    const response = await worker.fetch(
      new Request(`https://example.test/spotify/callback?code=auth-code&state=${state}`),
      env,
      ctx,
    );
    assert.equal(response.status, 200);
    assert.equal(
      await response.text(),
      'Spotify authorization complete. You can return to Discord.',
    );
    const storedTokens = JSON.parse((await env.SPOTIFY_TOKENS.get('spotify:tokens'))!);
    assert.equal(storedTokens.accessToken, 'access-token');
    assert.equal(storedTokens.refreshToken, 'refresh-token');
    assert.equal(storedTokens.tokenType, 'Bearer');
    assert.equal(storedTokens.scope, '');
    assert.ok(storedTokens.accessTokenExpiresAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Spotify callback rejects malformed OAuth state without leaking JSON parse errors', async () => {
  const env = testEnv();
  const state = 'state-value';
  await env.SPOTIFY_TOKENS.put(`spotify:oauth:state:${state}`, 'not valid json with spaces');

  const response = await worker.fetch(
    new Request(`https://example.test/spotify/callback?code=auth-code&state=${state}`),
    env,
    ctx,
  );
  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'OAuth state expired or invalid. Run /spotify login again.');
});

test('unauthorized /spotify now returns an ephemeral interaction error', async () => {
  const env = testEnv();
  const response = await worker.fetch(
    signedInteractionRequest({
      type: 2,
      data: {
        name: 'spotify',
        options: [{ type: 1, name: 'now' }],
      },
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.type, 4);
  assert.equal(payload.data.flags, 64);
  assert.match(payload.data.content, /Spotify is not authorized/);
});

test('legacy raw refresh token in KV refreshes instead of throwing a JSON parse error', async () => {
  const env = testEnv();
  await env.SPOTIFY_TOKENS.put('spotify:tokens', 'Sbw43bbzaH_legacyRawRefreshToken');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href === 'https://accounts.spotify.com/api/token') {
      assert.equal(
        (init?.body as URLSearchParams).get('refresh_token'),
        'Sbw43bbzaH_legacyRawRefreshToken',
      );
      return jsonResponse({
        access_token: 'access-token',
        refresh_token: 'refreshed-token',
        expires_in: 3600,
      });
    }
    if (url.pathname === '/v1/me/player') {
      return jsonResponse({
        is_playing: false,
        progress_ms: 0,
        device: { id: 'device-id', name: 'Desk', type: 'Computer', is_active: true },
        item: {
          id: 'track-id',
          type: 'track',
          name: 'Track',
          duration_ms: 180_000,
          artists: [{ name: 'Artist' }],
          album: { name: 'Album', images: [] },
        },
      });
    }
    if (url.pathname === '/v1/me/library/contains') {
      return jsonResponse([false]);
    }
    throw new Error(`unexpected fetch: ${url.href}`);
  }) as typeof fetch;

  try {
    const response = await worker.fetch(
      signedInteractionRequest({
        type: 2,
        data: {
          name: 'spotify',
          options: [{ type: 1, name: 'now' }],
        },
      }),
      env,
      ctx,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.type, 4);
    assert.equal(payload.data.embeds[0].title, 'Track');
    assert.equal(
      JSON.parse((await env.SPOTIFY_TOKENS.get('spotify:tokens'))!).refreshToken,
      'refreshed-token',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stale playback card controls do not send Spotify playback commands', async () => {
  const env = testEnv();
  await env.SPOTIFY_TOKENS.put(
    'spotify:tokens',
    JSON.stringify({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  );
  await env.SPOTIFY_TOKENS.put('discord:last-message-id', 'message-id');
  await env.SPOTIFY_TOKENS.put('discord:last-track-id', 'old-track-id');

  const originalFetch = globalThis.fetch;
  const seenPaths: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seenPaths.push(url.pathname);
    if (url.pathname === '/v1/me/player') {
      return jsonResponse({
        is_playing: true,
        progress_ms: 42_000,
        device: { id: 'device-id', name: 'Desk', type: 'Computer', is_active: true },
        item: {
          id: 'current-track-id',
          type: 'track',
          name: 'Current Track',
          duration_ms: 180_000,
          artists: [{ name: 'Artist' }],
          album: { name: 'Album', images: [] },
        },
      });
    }
    throw new Error(`unexpected fetch: ${url.href}`);
  }) as typeof fetch;

  try {
    const response = await worker.fetch(
      signedInteractionRequest({
        type: 3,
        data: { custom_id: 'spotify_worker:v1:pause' },
        message: {
          id: 'message-id',
          content: '',
          embeds: [{ url: 'https://open.spotify.com/track/old-track-id' }],
          components: playbackComponents(false),
        },
      }),
      env,
      ctx,
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.type, 7);
    const buttons = payload.data.components[0].components;
    assert.equal(buttons[0].disabled, true);
    assert.equal(buttons[1].disabled, true);
    assert.equal(buttons[2].disabled, true);
    assert.equal(buttons[3].disabled ?? false, false);
    assert.deepEqual(seenPaths, ['/v1/me/player']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('playback controls post a new card immediately when the track changes', async () => {
  const env = {
    ...testEnv(),
    DISCORD_CHANNEL_ID: 'channel-id',
    DISCORD_BOT_TOKEN: 'discord-bot-token',
    PLAYBACK_CONTROL_RETRY_DELAYS_MS: '0,0',
  };
  await env.SPOTIFY_TOKENS.put(
    'spotify:tokens',
    JSON.stringify({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  );
  await env.SPOTIFY_TOKENS.put('discord:last-message-id', 'message-id');
  await env.SPOTIFY_TOKENS.put('discord:last-track-id', 'old-track-id');

  const originalFetch = globalThis.fetch;
  const capturedLogs = captureConsoleLogs();
  const waitUntilPromises: Promise<unknown>[] = [];
  const waitUntilCtx = {
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise);
    },
  };
  const seenRequests: string[] = [];
  let playerFetches = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seenRequests.push(`${init?.method || 'GET'} ${url.pathname}`);

    if (url.pathname === '/v1/me/player') {
      playerFetches += 1;
      return jsonResponse({
        is_playing: true,
        progress_ms: playerFetches < 3 ? 42_000 : 1_000,
        device: { id: 'device-id', name: 'Desk', type: 'Computer', is_active: true },
        item: {
          id: playerFetches < 3 ? 'old-track-id' : 'new-track-id',
          type: 'track',
          name: playerFetches < 3 ? 'Old Track' : 'New Track',
          duration_ms: 180_000,
          artists: [{ name: 'Artist' }],
          album: { name: 'Album', images: [] },
        },
      });
    }
    if (url.pathname === '/v1/me/player/next') {
      return new Response('i05xhUT6bO-non-json-success-body', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    if (url.pathname === '/v1/me/library/contains') {
      assert.equal(url.searchParams.get('uris'), 'spotify:track:new-track-id');
      return jsonResponse([false]);
    }
    if (url.pathname === '/api/v10/channels/channel-id/messages' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      assert.equal(body.embeds[0].title, 'New Track');
      return jsonResponse({ id: 'new-message-id' });
    }
    if (
      url.pathname === '/api/v10/channels/channel-id/messages/message-id' &&
      init?.method === 'GET'
    ) {
      return jsonResponse({
        id: 'message-id',
        content: '',
        embeds: [{ url: 'https://open.spotify.com/track/old-track-id' }],
        components: playbackComponents(true),
      });
    }
    if (
      url.pathname === '/api/v10/channels/channel-id/messages/message-id' &&
      init?.method === 'PATCH'
    ) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.components[0].components[0].disabled, true);
      assert.equal(body.components[0].components[1].disabled, true);
      assert.equal(body.components[0].components[2].disabled, true);
      return jsonResponse({ id: 'message-id' });
    }
    throw new Error(`unexpected fetch: ${url.href}`);
  }) as typeof fetch;

  try {
    const response = await worker.fetch(
      signedInteractionRequest({
        type: 3,
        data: { custom_id: 'spotify_worker:v1:next' },
        message: {
          id: 'message-id',
          content: '',
          embeds: [{ url: 'https://open.spotify.com/track/old-track-id' }],
          components: playbackComponents(true),
        },
      }),
      env,
      waitUntilCtx,
    );
    await Promise.all(waitUntilPromises);

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.type, 7);
    assert.equal(payload.data.embeds[0].url, 'https://open.spotify.com/track/old-track-id');
    assert.equal(payload.data.components[0].components[0].disabled, true);
    assert.equal(payload.data.components[0].components[1].disabled, true);
    assert.equal(payload.data.components[0].components[2].disabled, true);
    assert.equal(await env.SPOTIFY_TOKENS.get('discord:last-message-id'), 'new-message-id');
    assert.equal(await env.SPOTIFY_TOKENS.get('discord:last-track-id'), 'new-track-id');
    const events = capturedLogs.events();
    assert.deepEqual(
      events
        .filter((event) => event.event === 'spotify_component_branch')
        .map((event) => event.branch),
      ['queue_new_card_for_next_prev'],
    );
    assert.deepEqual(
      events
        .filter((event) => event.event === 'spotify_control_upsert_retry')
        .map((event) => event.trackId),
      ['new-track-id'],
    );
    assert.deepEqual(
      events
        .filter((event) => event.event === 'spotify_card_upsert_result')
        .map((event) => event.action),
      ['posted'],
    );
    assert.deepEqual(
      events
        .filter((event) => event.event === 'spotify_control_upsert_result')
        .map((event) => ({ action: event.action, trackId: event.trackId })),
      [{ action: 'posted', trackId: 'new-track-id' }],
    );
    assert.deepEqual(
      events.filter((event) => event.event === 'spotify_component_control_failed'),
      [],
    );
    assert.deepEqual(seenRequests, [
      'GET /v1/me/player',
      'POST /v1/me/player/next',
      'GET /v1/me/player',
      'GET /v1/me/player',
      'GET /v1/me/library/contains',
      'POST /api/v10/channels/channel-id/messages',
      'GET /api/v10/channels/channel-id/messages/message-id',
      'PATCH /api/v10/channels/channel-id/messages/message-id',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    capturedLogs.restore();
  }
});

test('next and prev controls never render a fetched track into the clicked card', async () => {
  const env = testEnv();
  await env.SPOTIFY_TOKENS.put(
    'spotify:tokens',
    JSON.stringify({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/v1/me/player') {
      return jsonResponse({
        is_playing: true,
        progress_ms: 1_000,
        device: { id: 'device-id', name: 'Desk', type: 'Computer', is_active: true },
        item: {
          id: 'new-track-id',
          type: 'track',
          name: 'New Track',
          duration_ms: 180_000,
          artists: [{ name: 'Artist' }],
          album: { name: 'Album', images: [] },
        },
      });
    }
    if (url.pathname === '/v1/me/player/next') {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch: ${url.href}`);
  }) as typeof fetch;

  try {
    const response = await worker.fetch(
      signedInteractionRequest({
        type: 3,
        data: { custom_id: 'spotify_worker:v1:next' },
        message: {
          id: 'message-id',
          content: '',
          embeds: [{ title: 'Old Track', url: 'https://open.spotify.com/track/old-track-id' }],
          components: playbackComponents(true),
        },
      }),
      env,
      ctx,
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.type, 7);
    assert.equal(payload.data.embeds[0].title, 'Old Track');
    assert.equal(payload.data.embeds[0].url, 'https://open.spotify.com/track/old-track-id');
    assert.equal(payload.data.components[0].components[0].disabled, true);
    assert.equal(payload.data.components[0].components[1].disabled, true);
    assert.equal(payload.data.components[0].components[2].disabled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('playback control failures refresh the card instead of leaving stale UI', async () => {
  const env = testEnv();
  await env.SPOTIFY_TOKENS.put(
    'spotify:tokens',
    JSON.stringify({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  );

  const originalFetch = globalThis.fetch;
  let playerFetches = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/v1/me/player') {
      playerFetches += 1;
      return jsonResponse({
        is_playing: true,
        progress_ms: 42_000,
        device: { id: 'device-id', name: 'Desk', type: 'Computer', is_active: true },
        item: {
          id: 'current-track-id',
          type: 'track',
          name: 'Current Track',
          duration_ms: 180_000,
          artists: [{ name: 'Artist' }],
          album: { name: 'Album', images: [] },
        },
      });
    }
    if (url.pathname === '/v1/me/player/pause') {
      return jsonResponse(
        {
          error: {
            status: 403,
            message: 'Player command failed: Restriction violated',
            reason: 'UNKNOWN',
          },
        },
        403,
      );
    }
    if (url.pathname === '/v1/me/library/contains') {
      return jsonResponse([false]);
    }
    throw new Error(`unexpected fetch: ${url.href}`);
  }) as typeof fetch;

  try {
    const response = await worker.fetch(
      signedInteractionRequest({
        type: 3,
        data: { custom_id: 'spotify_worker:v1:pause' },
        message: {
          id: 'message-id',
          content: '',
          embeds: [{ url: 'https://open.spotify.com/track/current-track-id' }],
          components: playbackComponents(true),
        },
      }),
      env,
      ctx,
    );

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.type, 7);
    assert.equal(payload.data.embeds[0].title, 'Current Track');
    assert.equal(payload.data.embeds[0].footer.text, 'control failed | worker');
    assert.equal(playerFetches, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/spotify now renders saved like state for saved tracks', async () => {
  const env = testEnv();
  await env.SPOTIFY_TOKENS.put(
    'spotify:tokens',
    JSON.stringify({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/v1/me/player') {
      return jsonResponse({
        is_playing: true,
        progress_ms: 42_000,
        device: { id: 'device-id', name: 'Desk', type: 'Computer', is_active: true },
        item: {
          id: 'saved-track-id',
          type: 'track',
          name: 'Saved Track',
          duration_ms: 180_000,
          artists: [{ name: 'Artist' }],
          album: { name: 'Album', images: [] },
        },
      });
    }
    if (url.pathname === '/v1/me/library/contains') {
      assert.equal(url.searchParams.get('uris'), 'spotify:track:saved-track-id');
      return jsonResponse([true]);
    }
    throw new Error(`unexpected fetch: ${url.href}`);
  }) as typeof fetch;

  try {
    const response = await worker.fetch(
      signedInteractionRequest({
        type: 2,
        data: {
          name: 'spotify',
          options: [{ type: 1, name: 'now' }],
        },
      }),
      env,
      ctx,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    const likeButton = payload.data.components[0].components[3];
    assert.equal(likeButton.style, 3);
    assert.deepEqual(likeButton.emoji, { name: '✔️' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function signedInteractionRequest(payload) {
  const body = JSON.stringify(payload);
  const timestamp = '1760000000';
  const signature = nacl.sign.detached(
    new TextEncoder().encode(`${timestamp}${body}`),
    keyPair.secretKey,
  );

  return new Request('https://example.test/discord/interactions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-signature-ed25519': bytesToHex(signature),
      'x-signature-timestamp': timestamp,
    },
    body,
  });
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function captureConsoleLogs() {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = ((...values: unknown[]) => {
    lines.push(values.map(String).join(' '));
  }) as typeof console.log;

  return {
    events() {
      return lines.map((line) => JSON.parse(line));
    },
    restore() {
      console.log = originalLog;
    },
  };
}

function playbackComponents(isPlaying: boolean) {
  return [
    {
      type: 1,
      components: [
        { type: 2, custom_id: 'spotify_worker:v1:prev', style: 2, emoji: { name: '⏮️' } },
        {
          type: 2,
          custom_id: `spotify_worker:v1:${isPlaying ? 'pause' : 'play'}`,
          style: isPlaying ? 2 : 3,
          emoji: { name: isPlaying ? '⏸️' : '▶️' },
        },
        { type: 2, custom_id: 'spotify_worker:v1:next', style: 2, emoji: { name: '⏭️' } },
        { type: 2, custom_id: 'spotify_worker:v1:like', style: 2, emoji: { name: '➕' } },
      ],
    },
  ];
}
