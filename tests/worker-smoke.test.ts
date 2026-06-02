// @ts-nocheck

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import worker from '../worker/src/index';

const keyPair = nacl.sign.keyPair();

class MemoryKv {
  constructor() {
    this.values = new Map();
  }

  async get(key, type = 'text') {
    const value = this.values.get(key) ?? null;
    if (value === null) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
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
  assert.deepEqual(await response.json(), { ok: true });
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

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
