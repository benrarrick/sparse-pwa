import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createScheduler, Cancelled, QueueFull } from '../js/ai-ops.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(opts) {
  const events = [];
  const sched = createScheduler({ onEvent: (e) => events.push(e), ...opts });
  let active = 0;
  let peak = 0;
  const work = (name, ms = 5, { fail = false, order = [] } = {}) => async (ctx) => {
    active++;
    peak = Math.max(peak, active);
    order.push(`start ${name}`);
    try {
      await sleep(ms);
      if (fail) throw new Error(`${name} broke`);
      return name;
    } finally {
      order.push(`end ${name}`);
      active--;
    }
  };
  return { sched, events, work, peak: () => peak };
}

test('operations never overlap, however many are submitted at once', async () => {
  const { sched, work, peak } = harness();
  const order = [];
  const types = ['load', 'generate', 'embed', 'generate', 'unload', 'embed'];
  const results = await Promise.all(types.map((t, i) => sched.run({ type: t }, work(`${t}${i}`, 3, { order }))));
  assert.equal(peak(), 1);
  assert.deepEqual(results, types.map((t, i) => `${t}${i}`));
  assert.deepEqual(order.filter((x) => x.startsWith('start')).map((x) => x.slice(6)), types.map((t, i) => `${t}${i}`), 'first come, first served');
  assert.equal(sched.state, 'idle');
});

test('the state follows the running operation', async () => {
  const { sched } = harness();
  const seen = [];
  const mk = (type) => sched.run({ type }, async () => (seen.push(sched.state), sleep(2)));
  await Promise.all(['load', 'embed', 'generate', 'unload'].map(mk));
  assert.deepEqual(seen, ['loading', 'embedding', 'generating', 'unloading']);
  await sched.recover(async () => seen.push(sched.state));
  assert.equal(seen.at(-1), 'recovering');
});

test('an error releases the lock for the next operation', async () => {
  const { sched, work } = harness();
  const bad = sched.run({ type: 'generate' }, work('bad', 2, { fail: true }));
  const good = sched.run({ type: 'generate' }, work('good', 2));
  await assert.rejects(bad, /bad broke/);
  assert.equal(await good, 'good');
  assert.equal(sched.snapshot().counters.failed, 1);
  assert.equal(sched.busy, false);
});

test('a nested step runs under the same lock instead of deadlocking', async () => {
  const { sched, events } = harness();
  const out = await sched.run({ type: 'generate', label: 'answer' }, async (ctx) => {
    const loaded = await ctx.child({ type: 'load' }, async (c) => (c.stage('weights'), 'loaded'));
    assert.equal(sched.state, 'generating', 'back to the parent state afterwards');
    return loaded + '+generated';
  });
  assert.equal(out, 'loaded+generated');
  const child = events.find((e) => e.ev === 'ai.operation.started' && e.type === 'load');
  const parent = events.find((e) => e.ev === 'ai.operation.started' && e.type === 'generate');
  assert.equal(child.parent, parent.op, 'parent / child relationship is preserved');
  assert.notEqual(child.op, parent.op, 'every operation has its own id');
});

test('queued operations can be cancelled without disturbing the rest', async () => {
  const { sched, work } = harness();
  const a = sched.run({ type: 'generate', owner: 'screen1' }, work('a', 15));
  const b = sched.run({ type: 'generate', owner: 'screen2' }, work('b', 2));
  const c = sched.run({ type: 'generate', owner: 'screen2' }, work('c', 2));
  const d = sched.run({ type: 'generate', owner: 'screen1' }, work('d', 2));
  await sleep(2);
  assert.equal(sched.cancel((o) => o.owner === 'screen2' && o.startedAt == null), 2);
  await assert.rejects(b, Cancelled);
  await assert.rejects(c, Cancelled);
  assert.deepEqual([await a, await d], ['a', 'd']);
  assert.equal(sched.snapshot().counters.cancelled, 2);
});

test('cancelling the running operation aborts its signal, and the queue carries on', async () => {
  const { sched } = harness();
  let sawAbort = false;
  const a = sched.run({ type: 'generate', id: 'g1' }, async (ctx) => {
    await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
    sawAbort = ctx.cancelled();
    throw new Cancelled();
  });
  const b = sched.run({ type: 'generate' }, async () => 'next');
  await sleep(2);
  assert.equal(sched.cancel('g1'), 1);
  await assert.rejects(a, Cancelled);
  assert.equal(await b, 'next');
  assert.ok(sawAbort);
});

test('recover abandons a stuck operation, clears the queue and runs first', async () => {
  const { sched, events } = harness();
  const stuck = sched.run({ type: 'generate' }, () => new Promise(() => {})); // never finishes
  const waiting = sched.run({ type: 'generate' }, async () => 'never');
  await sleep(2);
  const order = [];
  const rec = sched.recover(async () => order.push('recover ran'));
  await assert.rejects(stuck, Cancelled);
  await assert.rejects(waiting, Cancelled);
  await rec;
  assert.deepEqual(order, ['recover ran']);
  assert.equal(await sched.run({ type: 'generate' }, async () => 'works again'), 'works again');
  assert.ok(events.some((e) => e.ev === 'ai.operation.abandoned'));
});

test('a late result from an abandoned operation is ignored', async () => {
  const { sched } = harness();
  let release;
  const slow = sched.run({ type: 'generate' }, () => new Promise((r) => (release = r)));
  await sleep(2);
  const rec = sched.recover(async () => {});
  await assert.rejects(slow, Cancelled);
  await rec;
  const after = sched.run({ type: 'generate' }, async () => sleep(10).then(() => 'fresh'));
  release('stale'); // the abandoned work finishes while a new operation runs
  assert.equal(await after, 'fresh');
  assert.equal(sched.snapshot().active, null);
});

test('the queue is bounded', async () => {
  const { sched } = harness({ maxQueue: 2 });
  const first = sched.run({ type: 'generate' }, () => sleep(10));
  await sleep(1);
  const q1 = sched.run({ type: 'generate' }, async () => 1);
  const q2 = sched.run({ type: 'generate' }, async () => 2);
  await assert.rejects(sched.run({ type: 'generate' }, async () => 3), QueueFull);
  await Promise.all([first, q1, q2]);
  assert.equal(sched.snapshot().counters.rejected, 1);
  assert.equal(sched.snapshot().counters.peakQueue, 2);
});

test('urgent operations go to the front of the queue but never in front of the running one', async () => {
  const { sched } = harness();
  const order = [];
  const a = sched.run({ type: 'generate' }, async () => (order.push('a'), sleep(10)));
  await sleep(1);
  const b = sched.run({ type: 'generate' }, async () => order.push('b'));
  const u = sched.run({ type: 'unload', urgent: true }, async () => order.push('urgent'));
  await Promise.all([a, b, u]);
  assert.deepEqual(order, ['a', 'urgent', 'b']);
});

test('a timeout aborts the operation and is reported as a failure, not a cancellation', async () => {
  const { sched, events } = harness();
  let timedOut = false;
  await assert.rejects(
    sched.run({ type: 'generate', timeoutMs: 15, onTimeout: () => (timedOut = true) }, async (ctx) => {
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
      throw ctx.signal.reason;
    }),
    (e) => e.code === 'INFERENCE_TIMEOUT',
  );
  assert.ok(timedOut);
  assert.ok(events.some((e) => e.ev === 'ai.operation.timeout'));
  assert.ok(events.some((e) => e.ev === 'ai.operation.failed' && e.code === 'INFERENCE_TIMEOUT'));
  assert.equal(await sched.run({ type: 'generate' }, async () => 'ok'), 'ok');
});

test('events are ordered, identified and counted', async () => {
  const { sched, events } = harness();
  await sched.run({ type: 'generate', pkg: 'lfm350', label: 'summary' }, async (ctx) => {
    ctx.stage('tokenize');
    ctx.stage('prefill');
  });
  const mine = events.filter((e) => e.type === 'generate').map((e) => e.ev);
  assert.deepEqual(mine, ['ai.operation.queued', 'ai.operation.started', 'ai.operation.stage', 'ai.operation.stage', 'ai.operation.completed']);
  const ids = new Set(events.map((e) => e.op));
  assert.equal(ids.size, 1);
  const stages = events.filter((e) => e.ev === 'ai.operation.stage').map((e) => e.stage);
  assert.deepEqual(stages, ['tokenize', 'prefill']);
  const failed = harness();
  await assert.rejects(failed.sched.run({ type: 'generate' }, async (ctx) => (ctx.stage('prefill'), Promise.reject(new Error('x')))));
  const f = failed.events.find((e) => e.ev === 'ai.operation.failed');
  assert.equal(f.stage, 'prefill', 'a failure carries the stage it failed in');
});

test('a throwing listener cannot stall the queue', async () => {
  const sched = createScheduler({ onEvent: () => { throw new Error('listener bug'); } });
  assert.equal(await sched.run({ type: 'generate' }, async () => 'fine'), 'fine');
});

test('markFailed shows in the state until cleared', async () => {
  const { sched } = harness();
  sched.markFailed({ code: 'GPU_DEVICE_LOST' });
  assert.equal(sched.state, 'failed');
  sched.clearFailed();
  assert.equal(sched.state, 'idle');
});
