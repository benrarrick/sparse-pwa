// One operation at a time. Loading a model, embedding, generating, switching models, unloading and
// recovering are all "operations"; this scheduler runs them strictly one after another, in order.
// It is used twice: by the engine (so even a page that sends overlapping messages cannot overlap
// the work) and by the page (so the screens queue instead of colliding).
//
//   run(spec, fn)     queue an operation; fn(ctx) runs when every earlier one is finished
//   ctx.child(spec,fn) a step inside the running operation (runs at once under the same lock, so
//                     generate() can load the model without waiting behind itself)
//   cancel(...)       drop queued operations; ask the running one to stop
//   recover(fn)       abandon the running operation, drop the queue, and run fn first: for resets
//
// An error never leaves the lock held, and an abandoned operation that finishes late is ignored.
// Pure: no DOM, no storage. Events go to `onEvent` (see ai-diag.js for their schema).

export class Cancelled extends Error {
  constructor(msg = 'Cancelled') {
    super(msg);
    this.name = 'Cancelled';
    this.code = 'CANCELLED';
  }
}

export class QueueFull extends Error {
  constructor(depth) {
    super(`The AI already has ${depth} tasks waiting, so this one was not added`);
    this.name = 'QueueFull';
    this.code = 'QUEUE_FULL';
  }
}

const STATE_OF = { load: 'loading', embed: 'embedding', generate: 'generating', unload: 'unloading', recover: 'recovering' };

export function createScheduler({ now = () => Date.now(), onEvent = () => {}, maxQueue = 8 } = {}) {
  let seq = 0;
  const queue = [];
  let active = null;
  let failed = null;
  const counters = { started: 0, completed: 0, failed: 0, cancelled: 0, abandoned: 0, peakQueue: 0, peakRequested: 0, rejected: 0 };

  const emit = (ev, op, extra = {}) => {
    try {
      onEvent({ ev, op: op.id, parent: op.parent ?? null, type: op.type, label: op.label, pkg: op.pkg, t: now(), ...extra });
    } catch {
      // a broken listener must never stall the queue
    }
  };

  const requested = () => queue.length + (active ? 1 : 0);

  function newOp(spec, fn, parent = null) {
    return {
      id: spec.id ?? `op${++seq}`,
      type: spec.type,
      label: spec.label ?? spec.type,
      pkg: spec.pkg ?? null,
      owner: spec.owner ?? null,
      urgent: !!spec.urgent,
      timeoutMs: spec.timeoutMs ?? 0,
      onTimeout: spec.onTimeout,
      parent,
      fn,
      ctrl: new AbortController(),
      queuedAt: now(),
      startedAt: null,
      stage: 'queued',
      currentType: spec.type,
      abandoned: false,
    };
  }

  function makeCtx(op) {
    return {
      id: op.id,
      signal: op.ctrl.signal,
      cancelled: () => op.ctrl.signal.aborted || op.abandoned,
      stage(name, data = {}) {
        op.stage = name;
        emit('ai.operation.stage', op, { stage: name, ms: now() - op.startedAt, ...data });
      },
      child: (spec, fn) => runChild(op, spec, fn),
    };
  }

  async function runChild(parent, spec, fn) {
    if (parent.abandoned) throw new Cancelled('The parent operation was abandoned');
    const child = newOp(spec, fn, parent.id);
    child.startedAt = now();
    const prev = parent.currentType;
    parent.currentType = spec.type;
    emit('ai.operation.started', child, { queueMs: 0, nested: true });
    try {
      const value = await fn(makeCtx(child));
      emit('ai.operation.completed', child, { status: 'ok', ms: now() - child.startedAt });
      return value;
    } catch (e) {
      emit('ai.operation.failed', child, { status: 'error', code: e?.code ?? null, ms: now() - child.startedAt, stage: child.stage, msg: e?.message });
      throw e;
    } finally {
      parent.currentType = prev;
    }
  }

  async function pump() {
    if (active || !queue.length) return;
    const op = queue.shift();
    active = op;
    op.startedAt = now();
    counters.started++;
    emit('ai.operation.started', op, { queueMs: op.startedAt - op.queuedAt, depth: queue.length });
    let timer = null;
    if (op.timeoutMs)
      timer = setTimeout(() => {
        emit('ai.operation.timeout', op, { ms: now() - op.startedAt, stage: op.stage });
        op.ctrl.abort(Object.assign(new Error(`Timed out after ${Math.round(op.timeoutMs / 1000)} s`), { code: 'INFERENCE_TIMEOUT' }));
        try {
          op.onTimeout?.(op);
        } catch {
          // as above
        }
      }, op.timeoutMs);
    try {
      const value = await op.fn(makeCtx(op));
      if (!op.abandoned) {
        counters.completed++;
        emit('ai.operation.completed', op, { status: 'ok', ms: now() - op.startedAt, stage: op.stage });
        op.resolve(value);
      }
    } catch (e) {
      if (!op.abandoned) {
        const timedOut = op.ctrl.signal.reason?.code === 'INFERENCE_TIMEOUT';
        const cancelled = !timedOut && (e instanceof Cancelled || op.ctrl.signal.aborted);
        if (cancelled) counters.cancelled++;
        else counters.failed++;
        const err = timedOut && !e?.code ? op.ctrl.signal.reason : e;
        emit(cancelled ? 'ai.operation.cancelled' : 'ai.operation.failed', op, { status: cancelled ? 'cancelled' : 'error', code: err?.code ?? null, ms: now() - op.startedAt, stage: op.stage, msg: err?.message });
        op.reject(err);
      }
    } finally {
      clearTimeout(timer);
      if (active === op) active = null; // an abandoned operation was already replaced
      pump();
    }
  }

  function run(spec, fn) {
    return new Promise((resolve, reject) => {
      if (queue.length >= maxQueue) {
        counters.rejected++;
        return reject(new QueueFull(queue.length));
      }
      const op = newOp(spec, fn);
      op.resolve = resolve;
      op.reject = reject;
      if (spec.signal) {
        if (spec.signal.aborted) return reject(new Cancelled());
        spec.signal.addEventListener('abort', () => cancel((o) => o === op), { once: true });
      }
      // urgent operations go first, but never in front of the running one
      if (op.urgent) queue.unshift(op);
      else queue.push(op);
      counters.peakQueue = Math.max(counters.peakQueue, queue.length);
      counters.peakRequested = Math.max(counters.peakRequested, requested());
      emit('ai.operation.queued', op, { depth: queue.length, requested: requested() });
      pump();
    });
  }

  /**
   * Cancels queued operations that match (an id, or a predicate on the operation), and asks the
   * running one to stop if it matches. Returns how many were affected.
   */
  function cancel(match = () => true, reason = 'Cancelled') {
    const test = typeof match === 'function' ? match : (o) => o.id === match;
    let n = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!test(queue[i])) continue;
      const [op] = queue.splice(i, 1);
      counters.cancelled++;
      emit('ai.operation.cancelled', op, { status: 'cancelled', stage: 'queued', msg: reason });
      op.reject(new Cancelled(reason));
      n++;
    }
    if (active && test(active) && !active.ctrl.signal.aborted) {
      active.ctrl.abort(new Cancelled(reason));
      n++;
    }
    return n;
  }

  /**
   * For resets: drops everything queued, abandons the running operation (its promise rejects at
   * once, and whatever it does afterwards is ignored), then runs `fn` before anything else.
   */
  function recover(fn, spec = {}) {
    cancel((o) => o !== active, 'The AI engine was reset');
    if (active) {
      const op = active;
      op.abandoned = true;
      counters.abandoned++;
      op.ctrl.abort(new Cancelled('The AI engine was reset'));
      emit('ai.operation.abandoned', op, { status: 'abandoned', stage: op.stage });
      active = null;
      op.reject(new Cancelled('The AI engine was reset'));
    }
    return run({ type: 'recover', label: 'recover', urgent: true, ...spec }, fn);
  }

  return {
    run,
    cancel,
    recover,
    /** 'idle', 'loading', 'embedding', 'generating', 'unloading', 'recovering' or 'failed'. */
    get state() {
      return active ? (STATE_OF[active.currentType] ?? 'idle') : failed ? 'failed' : 'idle';
    },
    get busy() {
      return !!active;
    },
    get depth() {
      return queue.length;
    },
    markFailed(info) {
      failed = info ?? { at: now() };
    },
    clearFailed() {
      failed = null;
    },
    snapshot() {
      return {
        state: active ? (STATE_OF[active.currentType] ?? 'idle') : failed ? 'failed' : 'idle',
        failed,
        active: active ? { id: active.id, type: active.type, label: active.label, pkg: active.pkg, stage: active.stage, startedAt: active.startedAt, owner: active.owner } : null,
        queue: queue.map((o) => ({ id: o.id, type: o.type, label: o.label, pkg: o.pkg, owner: o.owner, waitingMs: now() - o.queuedAt })),
        counters: { ...counters },
      };
    },
  };
}
