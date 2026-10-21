import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('./probe.mjs', import.meta.url), 'utf8');
const pageScript = source.match(/<script>\n([\s\S]*?)<\/script>/)?.[1];
assert.ok(pageScript, 'test the actual embedded fixture implementation');

function fixture() {
  let now = 0;
  let nextId = 0;
  let requestCalls = 0;
  const tasks = new Map();
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [base + now])); }
    static now() { return base + now; }
  }
  const schedule = (fn, delay) => {
    const id = ++nextId;
    tasks.set(id, {id, at: now + Math.max(0, Number(delay)), fn});
    return id;
  };
  const waiting = new Map();
  const provider = {
    isRabby: true,
    _isReady: true,
    _initialized: true,
    _state: {initialized: true},
    _cacheRequestsBeforeReady: [],
    isConnected: () => true,
    _bcm: {_waitingMap: waiting, _channel: {readable: true, writable: true, destroyed: false}},
    request() { requestCalls++; throw new Error('The setup barrier must not request wallet data'); },
  };
  const document = {readyState: 'complete', visibilityState: 'visible', addEventListener() {}, querySelector() { return {textContent: ''}; }};
  const window = {ethereum: provider, addEventListener() {}, dispatchEvent() {}};
  vm.runInNewContext(pageScript, {
    window, document, navigator: {serviceWorker: {register: () => Promise.resolve({})}},
    location: {href: 'http://127.0.0.1/?surface=pwa'},
    crypto: {randomUUID: () => 'fixture-document'}, Event,
    matchMedia: () => ({matches: true}),
    performance: {now: () => now, getEntriesByType: () => []},
    Date: ClockDate, setTimeout: schedule, clearTimeout: id => tasks.delete(id),
  });
  async function complete(promise) {
    let settled = false;
    let result;
    let error;
    promise.then(value => { settled = true; result = value; }, reason => { settled = true; error = reason; });
    for (let count = 0; count < 10000; count++) {
      await Promise.resolve();
      await Promise.resolve();
      if (settled) { if (error) throw error; return result; }
      const next = [...tasks.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
      assert.ok(next, 'pending fixture operation has a scheduled continuation');
      tasks.delete(next.id);
      now = next.at;
      next.fn();
    }
    throw new Error('fake clock did not converge');
  }
  return {provider, waiting, document, schedule, complete, probe: window.__rabbyProbe, requestCalls: () => requestCalls};
}

test('initial setup waits for DOM, readiness, both initialization flags and the pre-ready cache', async () => {
  const f = fixture();
  f.document.readyState = 'loading';
  f.provider._isReady = false;
  f.provider._initialized = false;
  f.provider._state.initialized = false;
  f.provider._cacheRequestsBeforeReady.push({method: 'not-sent-by-this-test'});
  f.schedule(() => { f.document.readyState = 'complete'; }, 20);
  f.schedule(() => { f.provider._isReady = true; }, 40);
  f.schedule(() => { f.provider._initialized = true; }, 60);
  f.schedule(() => { f.provider._state.initialized = true; }, 80);
  f.schedule(() => { f.provider._cacheRequestsBeforeReady.length = 0; }, 100);
  const result = await f.complete(f.probe.waitForInitialReady(5000));
  assert.equal(result.status, 'ready');
  assert.equal(result.elapsedMs, 100);
  assert.equal(result.initialSnapshot.documentReadyState, 'loading');
  assert.ok(result.samples.some(item => item.providerInitialized && !item.stateInitialized));
  assert.ok(result.samples.some(item => item.stateInitialized && item.cachedRequestCount === 1));
  assert.equal(result.finalSnapshot.cachedRequestCount, 0);
  assert.equal(f.requestCalls(), 0);
});

test('initialized provider remains blocked until every concurrent initialization method drains', async () => {
  const f = fixture();
  for (const method of ['getProviderState', 'rabby:getProviderConfig', 'tabCheckin']) f.waiting.set(method, {data: {method, params: ['not recorded']}});
  f.schedule(() => f.waiting.delete('getProviderState'), 20);
  f.schedule(() => f.waiting.delete('rabby:getProviderConfig'), 40);
  f.schedule(() => f.waiting.delete('tabCheckin'), 60);
  const result = await f.complete(f.probe.waitForInitialReady(5000));
  assert.equal(result.status, 'ready');
  assert.equal(result.elapsedMs, 60);
  assert.deepEqual(Array.from(result.samples[0].waitingMethods), ['getProviderState', 'rabby:getProviderConfig', 'tabCheckin']);
  assert.ok(result.samples.some(item => item.waitingCount === 1 && item.waitingMethods[0] === 'tabCheckin'));
  assert.equal(result.finalSnapshot.waitingCount, 0);
  assert.equal(f.requestCalls(), 0);
});

test('five-second timeout retains the blocking method, original state and full sample trace', async () => {
  const f = fixture();
  f.waiting.set('blocked', {data: {method: 'tabCheckin', params: ['private-marker']}});
  const result = await f.complete(f.probe.waitForInitialReady(5000));
  assert.equal(result.status, 'deadline');
  assert.equal(result.timeoutMs, 5000);
  assert.equal(result.elapsedMs, 5000);
  assert.equal(Date.parse(result.finishedAt) - Date.parse(result.startedAt), 5000);
  assert.equal(result.initialSnapshot.waitingCount, 1);
  assert.equal(result.finalSnapshot.waitingCount, 1);
  assert.deepEqual(Array.from(result.finalSnapshot.waitingMethods), ['tabCheckin']);
  assert.equal(result.samples.length, 251);
  assert.equal(result.samples.at(-1).elapsedMs, 5000);
  assert.ok(!JSON.stringify(result).includes('private-marker'));
  assert.equal(f.requestCalls(), 0);
});

const assetFunctions = source.match(/async function readExtensionAssetInventory[\s\S]*?(?=\nconst sleep)/)?.[0];
assert.ok(assetFunctions, 'test the actual pre-launch and post-exit asset binding implementation');
const assetContext = vm.createContext({fs, path, createHash});
vm.runInContext(assetFunctions, assetContext);

async function assetFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rabby-asset-binding-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  await Promise.all([
    fs.writeFile(path.join(directory, 'background.js'), 'before'),
    fs.writeFile(path.join(directory, 'ui.js'), 'render'),
    fs.writeFile(path.join(directory, 'manifest.json'), '{}'),
  ]);
  const expected = await assetContext.readExtensionAssetInventory(directory);
  return {directory, expected};
}

test('asset binding verifies the full root and rejects a same-size compiled-asset mutation', async t => {
  const f = await assetFixture(t);
  const check = await assetContext.verifyExtensionAssetInventory(f.directory, f.expected);
  assert.equal(check.matched, true);
  assert.equal(check.checkedFileCount, 3);
  assert.equal(check.backgroundSha256, createHash('sha256').update('before').digest('hex'));
  await fs.writeFile(path.join(f.directory, 'background.js'), 'tamper');
  await assert.rejects(assetContext.verifyExtensionAssetInventory(f.directory, f.expected), error => {
    assert.equal(error.assetCheck.matched, false);
    assert.deepEqual(Array.from(error.assetCheck.changed), ['background.js']);
    assert.equal(error.assetCheck.missing.length, 0);
    assert.equal(error.assetCheck.unexpected.length, 0);
    return true;
  });
});

test('asset binding rejects extra files and symlinked assets', async t => {
  const f = await assetFixture(t);
  const extra = path.join(f.directory, 'extra.js');
  await fs.writeFile(extra, 'extra');
  await assert.rejects(assetContext.verifyExtensionAssetInventory(f.directory, f.expected), /inventory mismatch/);
  await fs.rm(extra);
  await fs.symlink('ui.js', extra);
  await assert.rejects(assetContext.verifyExtensionAssetInventory(f.directory, f.expected), /symlink is forbidden/);
});

test('asset binding treats special object-property filenames as exact file keys', async t => {
  const f = await assetFixture(t);
  await fs.writeFile(path.join(f.directory, '__proto__'), 'unexpected');
  await assert.rejects(assetContext.verifyExtensionAssetInventory(f.directory, f.expected), error => {
    assert.deepEqual(Array.from(error.assetCheck.unexpected), ['__proto__']);
    return true;
  });
});

test('asset binding rejects empty, malformed and incomplete expected inventories', async t => {
  const f = await assetFixture(t);
  for (const expected of [{}, [], {'../background.js': f.expected['background.js']}, {'background.js': f.expected['background.js']}]) {
    await assert.rejects(assetContext.verifyExtensionAssetInventory(f.directory, expected), /Expected extension inventory|Invalid expected extension asset/);
  }
});
