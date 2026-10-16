import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = process.env.FOMO_EXTENSION_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const CA = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const empty = { code: -1, error: '未找到故事记录' };
const story = { code: 0, data: { history: { ca_address: CA, story: { origin: 'fixture' } } } };

// Load the complete real worker and use its real message boundary and session cache.
function harness(reply, stored = {}) {
  let listener, now = Date.now();
  const calls = [];
  const context = vm.createContext({
    AbortController, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return now; } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return reply(url, options);
    },
    chrome: {
      runtime: { id: 'story-test', onMessage: { addListener(fn) { listener = fn; } } },
      storage: { session: {
        get: async key => ({ [key]: stored[key] }),
        set: async values => Object.assign(stored, values),
        remove: async key => { delete stored[key]; },
      } },
    },
  });
  vm.runInContext(source, context);
  return {
    calls, stored,
    advance(ms) { now += ms; },
    send(message = { type: 'debot-story', ca: CA }) {
      return new Promise(resolve => {
        assert.equal(listener(message, { id: 'story-test' }, resolve), true);
      });
    },
  };
}
const response = (status, body, headers) => new Response(JSON.stringify(body), { status, headers });

test('explicit no-record 404 uses the existing empty result and ten-minute cache', async () => {
  const h = harness(() => response(404, empty));
  assert.equal((await h.send()).kind, 'nostory');
  assert.equal((await h.send()).kind, 'nostory');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.credentials, 'omit');
  assert.equal((await h.send({ type: 'debot-story', ca: CA, force: true })).kind, 'nostory');
  assert.equal(h.calls.length, 2);
  h.advance(10 * 60 * 1000 + 1);
  assert.equal((await h.send()).kind, 'nostory');
  assert.equal(h.calls.length, 3);
});

test('confirmed empty survives worker recycling through the existing session cache', async () => {
  const first = harness(() => response(404, empty));
  await first.send();
  const next = harness(() => { throw new Error('cache should avoid fetch'); }, first.stored);
  assert.equal((await next.send()).kind, 'nostory');
  assert.equal(next.calls.length, 0);
});

for (const status of [401, 403, 429, 500, 503]) {
  test(`${status} stays a retryable error even when its body looks like no-record`, async () => {
    const h = harness(() => response(status, empty));
    assert.equal((await h.send()).kind, 'network');
    assert.equal((await h.send()).kind, 'network');
    assert.equal(h.calls.length, 4);
    assert.match(h.calls[1].url, /^https:\/\/debot\.ai\//);
  });
}

for (const body of [{}, { code: -1, error: 'backend route missing' }, { code: '-1', error: empty.error }, { code: -1 }]) {
  test(`generic or malformed 404 is not cached as no-story: ${JSON.stringify(body)}`, async () => {
    const h = harness(() => response(404, body));
    assert.equal((await h.send()).kind, 'network');
    assert.equal(Object.keys(h.stored).length, 0);
    assert.equal(h.calls.length, 2);
  });
}

test('HTML and declared oversized 404s remain HTTP failures', async () => {
  for (const reply of [
    () => new Response('<html>Not Found</html>', { status: 404 }),
    () => response(404, empty, { 'content-length': String(2 * 1024 * 1024 + 1) }),
  ]) {
    const h = harness(reply);
    assert.equal((await h.send()).kind, 'network');
    assert.equal(h.calls.length, 2);
  }
});

test('normal stories and existing HTTP-200 empty answers retain their cache behavior', async () => {
  for (const body of [story, empty]) {
    const h = harness(() => response(200, body));
    const a = await h.send(), b = await h.send();
    assert.equal(a.ok, body === story);
    assert.equal(b.ok, a.ok);
    if (a.ok) assert.equal(a.payload.ca_address, CA);
    else assert.equal(a.kind, 'nostory');
    assert.equal(h.calls.length, 1);
  }
});

test('a mismatched contract never becomes a cached story', async () => {
  const bad = structuredClone(story);
  bad.data.history.ca_address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const h = harness(() => response(200, bad));
  assert.equal((await h.send()).kind, 'mismatch');
  assert.equal(Object.keys(h.stored).length, 0);
});

test('network failures and timeouts remain retryable and uncached', async () => {
  for (const name of ['TypeError', 'AbortError']) {
    const h = harness(() => { throw Object.assign(new Error('failure'), { name }); });
    assert.equal((await h.send()).kind, 'network');
    assert.equal(h.calls.length, 2);
    assert.equal(Object.keys(h.stored).length, 0);
  }
});

test('non-story fetches do not consume or reclassify 404 response bodies', async () => {
  let bodyReads = 0;
  const h = harness(() => ({ ok: false, status: 404, json: async () => { bodyReads++; return empty; } }));
  const result = await h.send({ type: 'debot-tweets', ids: ['1234567890123456789'] });
  assert.equal(result.ok, true);
  assert.equal(result.payload.length, 0);
  assert.equal(bodyReads, 0);
});
