import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/lib.js';
import * as SP from '../js/speed.js';

test('mbit and transferMs', () => {
  assert.equal(L.mbit(250000, 1000), 2);
  assert.equal(L.mbit(0, 1000), null);
  assert.equal(L.mbit(1000, 0), null);
  assert.equal(L.transferMs({ ms: 1500, ttfb: 500 }), 1000);
  assert.equal(L.transferMs({ ms: 10, ttfb: 5 }), 10); // too short to trust the difference
});

test('formatMbit and speedLine', () => {
  assert.equal(L.formatMbit(0.25), '250 kbit/s');
  assert.equal(L.formatMbit(1.84), '1.8 Mbit/s');
  assert.equal(L.formatMbit(42.4), '42 Mbit/s');
  assert.equal(L.formatMbit(null), '?');
  assert.equal(L.speedLine({ mbit: 1.8, latency: 140, bytes: 250000 }), `1.8 Mbit/s down · 140 ms latency · used ${L.formatBytes(250000)}`);
  assert.equal(L.speedLine({ error: 'timed out' }), 'failed: timed out');
});

test('sources are named, and the Cloudflare url asks for an exact size', () => {
  assert.equal(SP.SOURCES.length, 2);
  assert.equal(SP.SOURCES[0].url(250000, 7), 'https://speed.cloudflare.com/__down?bytes=250000&r=7');
  assert.equal(L.serviceOf(SP.SOURCES[0].url(0, 1)), 'Cloudflare speed test');
});

test('runSource only fetches the big file when the small one was fast', async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const n = Number(new URL(url).searchParams.get('bytes'));
    asked.push(n);
    return new Response(new Uint8Array(n));
  };
  try {
    const r = await SP.runSource(SP.SOURCES[0], { nonce: 1 });
    assert.deepEqual(asked, [0, SP.SMALL, SP.LARGE]);
    assert.equal(r.bytes, SP.SMALL + SP.LARGE);
    assert.ok(r.mbit > 0);
    assert.ok(r.latency >= 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('runSource reports a failure instead of throwing', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('boom');
  };
  try {
    const r = await SP.runSource(SP.SOURCES[0], { nonce: 1 });
    assert.ok(r.error);
    assert.equal(r.bytes, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
