#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const flags = Object.fromEntries(process.argv.slice(2).reduce((out, arg, index, args) => {
  if (arg.startsWith('--')) out.push([arg.slice(2), args[index + 1]]);
  return out;
}, []));
if (!flags.browser || !flags.extension || !flags.output) {
  console.error('Usage: node probe.mjs --browser EXECUTABLE --extension UNPACKED_DIR --output RESULT.json [--mode natural|worker-stop|freeze] [--wait-ms 180000] [--request-timeout-ms 5000] [--ui-smoke true] [--expected-assets INVENTORY.json]');
  process.exit(2);
}
const mode = flags.mode ?? 'natural';
if (!['natural', 'worker-stop', 'freeze'].includes(mode)) throw new Error('Unknown mode');
const waitMs = Number(flags['wait-ms'] ?? 180000);
const requestTimeoutMs = Number(flags['request-timeout-ms'] ?? 5000);
if (!Number.isFinite(waitMs) || waitMs < 0 || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error('Invalid duration');
const output = path.resolve(flags.output);
const result = {
  schema: 1,
  startedAt: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  mode,
  waitMs,
  requestTimeoutMs,
  initialSetupTimeoutMs: 5000,
  uiSmoke: {requested: flags['ui-smoke'] === 'true', passed: null},
  observationTimingSchema: 1,
  walletState: 'isolated watch-only account 0x0000000000000000000000000000000000000001; no signing key',
  proofScope: mode === 'natural' ? 'Local installed standalone PWA with native window minimization; platform recorded separately.' : 'Controlled browser lifecycle fault; not a natural Linux PWA reproduction.',
  browserExecutable: path.resolve(flags.browser),
  extensionPath: path.resolve(flags.extension),
  observations: [],
  browserEvents: [],
  cleanup: {},
};

async function readExtensionAssetInventory(directory) {
  const rootState = await fs.lstat(directory);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) throw new Error('Extension asset root must be a directory, not a symlink');
  const inventory = Object.create(null);
  const visit = async (current, relative) => {
    const entries = (await fs.readdir(current)).sort();
    for (const name of entries) {
      const absolute = path.join(current, name);
      const key = relative ? relative + '/' + name : name;
      const before = await fs.lstat(absolute);
      if (before.isSymbolicLink()) throw new Error('Extension asset symlink is forbidden: ' + key);
      if (before.isDirectory()) { await visit(absolute, key); continue; }
      if (!before.isFile()) throw new Error('Extension asset is not a regular file: ' + key);
      const bytes = await fs.readFile(absolute);
      const after = await fs.lstat(absolute);
      if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) throw new Error('Extension asset changed while hashing: ' + key);
      inventory[key] = {bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
    }
  };
  await visit(directory, '');
  return inventory;
}

function validateExpectedAssetInventory(expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || !Object.keys(expected).length) throw new Error('Expected extension inventory must be a nonempty file map');
  for (const [key, info] of Object.entries(expected)) {
    if (!key || key.includes('\\') || key.startsWith('/') || key.split('/').some(part => !part || part === '.' || part === '..') || !info || typeof info !== 'object' || !Number.isSafeInteger(info.bytes) || info.bytes < 0 || typeof info.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(info.sha256)) throw new Error('Invalid expected extension asset record: ' + key);
  }
  for (const key of ['background.js', 'ui.js', 'manifest.json']) if (!expected[key]) throw new Error('Expected extension inventory omits required runtime asset: ' + key);
}

async function verifyExtensionAssetInventory(directory, expected) {
  validateExpectedAssetInventory(expected);
  const actual = await readExtensionAssetInventory(directory);
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  const missing = expectedKeys.filter(key => !Object.hasOwn(actual, key));
  const unexpected = actualKeys.filter(key => !Object.hasOwn(expected, key));
  const changed = expectedKeys.filter(key => Object.hasOwn(actual, key) && (actual[key].bytes !== expected[key].bytes || actual[key].sha256 !== expected[key].sha256));
  const matched = !missing.length && !unexpected.length && !changed.length;
  const check = {at: new Date().toISOString(), matched, checkedFileCount: actualKeys.length, expectedFileCount: expectedKeys.length, inventorySha256: createHash('sha256').update(JSON.stringify(actual)).digest('hex'), backgroundSha256: actual['background.js']?.sha256 ?? null, uiSha256: actual['ui.js']?.sha256 ?? null, manifestSha256: actual['manifest.json']?.sha256 ?? null, missing, unexpected, changed};
  if (!matched) throw Object.assign(new Error('Extension asset inventory mismatch: ' + JSON.stringify({missing, unexpected, changed})), {assetCheck: check});
  return check;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const validResponse = item => item.status === 'resolved' && typeof item.value === 'string' && /^0x[0-9a-f]+$/i.test(item.value);
const sameResponse = (item, baseline) => validResponse(item) && item.status === baseline.status && (item.status === 'resolved' ? item.value === baseline.value : item.error.code === baseline.error.code && item.error.message === baseline.error.message);
function png(size) {
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind, bytes) => {
    const body = Buffer.concat([Buffer.from(kind), bytes]);
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * (1 + size * 3) + 1 + x * 3;
    pixels[i] = 64; pixels[i + 1] = 86; pixels[i + 2] = 170;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

const pageSource = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" href="/manifest.webmanifest"><title>Rabby lifecycle probe</title></head>
<body><h1>Rabby lifecycle probe</h1><p>This local page sends read-only eth_chainId requests. It does not request accounts or signatures.</p><pre id="state">Starting</pre>
<script>
(() => {
  const events = [];
  const providers = [];
  const loadId = crypto.randomUUID();
  const record = (type, detail = {}) => events.push({type, at: Date.now(), sinceLoadMs: performance.now(), visibility: document.visibilityState, ...detail});
  for (const type of ['visibilitychange', 'freeze', 'resume']) document.addEventListener(type, () => record(type));
  for (const type of ['pageshow', 'pagehide', 'focus', 'blur']) window.addEventListener(type, event => record(type, {persisted: event.persisted ?? null}));
  window.addEventListener('eip6963:announceProvider', event => providers.push(event.detail));
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const provider = () => providers.find(p => p.provider?.isRabby)?.provider || (window.ethereum?.isRabby ? window.ethereum : null) || (window.rabby?.isRabby ? window.rabby : null) || window.ethereum?.providers?.find(p => p.isRabby);
  const snapshot = () => {
    const p = provider();
    let connected = null;
    try { connected = p?.isConnected?.() ?? p?._isConnected ?? null; } catch {}
    const channel = p?._bcm?._channel;
    const waitingMap = p?._bcm?._waitingMap;
    const waitingMethods = typeof waitingMap?.values === 'function' ? Array.from(waitingMap.values(), entry => entry?.data?.method).filter(method => typeof method === 'string') : null;
    return {loadId, standalone: matchMedia('(display-mode: standalone)').matches, href: location.href, navigationType: performance.getEntriesByType('navigation')[0]?.type ?? null, visibility: document.visibilityState, documentReadyState: document.readyState, wasDiscarded: document.wasDiscarded, hasRabby: !!p, isConnected: connected, providerReady: typeof p?._isReady === 'boolean' ? p._isReady : null, providerInitialized: typeof p?._initialized === 'boolean' ? p._initialized : null, stateInitialized: typeof p?._state?.initialized === 'boolean' ? p._state.initialized : null, cachedRequestCount: Array.isArray(p?._cacheRequestsBeforeReady) ? p._cacheRequestsBeforeReady.length : null, waitingCount: waitingMap?.size ?? null, waitingMethods, channel: channel ? {readable: channel.readable, writable: channel.writable, destroyed: channel.destroyed} : null, events: [...events]};
  };
  window.__rabbyProbe = {snapshot, async waitForInitialReady(timeoutMs) {
    const start = performance.now();
    const deadline = start + timeoutMs;
    const startedAt = new Date().toISOString();
    const samples = [];
    let initialSnapshot;
    for (;;) {
      const state = snapshot();
      initialSnapshot ??= state;
      const now = performance.now();
      const elapsedMs = now - start;
      const ready = state.documentReadyState === 'complete' && state.providerReady === true && state.providerInitialized === true && state.stateInitialized === true && state.cachedRequestCount === 0 && state.waitingCount === 0;
      samples.push({at: new Date().toISOString(), elapsedMs, documentReadyState: state.documentReadyState, providerReady: state.providerReady, providerInitialized: state.providerInitialized, stateInitialized: state.stateInitialized, cachedRequestCount: state.cachedRequestCount, waitingCount: state.waitingCount, waitingMethods: state.waitingMethods, visibility: state.visibility});
      if ((ready && now <= deadline) || now >= deadline) {
        return {status: ready && now <= deadline ? 'ready' : 'deadline', timeoutMs, startedAt, finishedAt: new Date().toISOString(), elapsedMs, samples, initialSnapshot, finalSnapshot: state};
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.ceil(deadline - now))));
    }
  }, async request(label, timeoutMs) {
    const p = provider();
    if (!p) throw new Error('No Rabby injected provider found');
    const start = performance.now();
    const startedAt = new Date().toISOString();
    record('requestStarted', {label, method: 'eth_chainId'});
    let timer;
    const pending = Promise.resolve().then(() => p.request({method: 'eth_chainId'}));
    pending.then(value => record('requestResolved', {label, value}), error => record('requestRejected', {label, message: String(error?.message || error), code: error?.code ?? null}));
    const outcome = await Promise.race([
      pending.then(value => ({status: 'resolved', value}), error => ({status: 'rejected', error: {message: String(error?.message || error), code: error?.code ?? null}})),
      new Promise(resolve => { timer = setTimeout(() => { record('requestDeadline', {label, deadlineMs: timeoutMs}); resolve({status: 'deadline', deadlineMs: timeoutMs}); }, timeoutMs); }),
    ]);
    clearTimeout(timer);
    record('requestFinished', {label, status: outcome.status});
    const finishedAt = new Date().toISOString();
    const observation = {label, ...outcome, startedAt, finishedAt, elapsedMs: performance.now() - start, snapshot: snapshot()};
    document.querySelector('#state').textContent = JSON.stringify(observation, null, 2);
    return observation;
  }};
  record('boot');
  navigator.serviceWorker.register('/sw.js').catch(error => record('pwaServiceWorkerError', {message: String(error)}));
})();
</script></body></html>`;
let origin;
const server = http.createServer((request, response) => {
  (result.httpRequests ??= []).push({at: new Date().toISOString(), url: request.url});
  response.setHeader('Cache-Control', 'no-store');
  const pathname = new URL(request.url, origin).pathname;
  if (pathname === '/manifest.webmanifest') {
    response.setHeader('Content-Type', 'application/manifest+json');
    response.end(JSON.stringify({id: '/', name: 'Rabby Lifecycle Probe', short_name: 'Rabby Probe', start_url: '/', scope: '/', display: 'standalone', background_color: '#4056aa', theme_color: '#4056aa', icons: [192, 512].map(size => ({src: '/icon-' + size + '.png', sizes: size + 'x' + size, type: 'image/png'}))}));
  } else if (pathname === '/sw.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});");
  } else if (/^\/icon-(192|512)\.png$/.test(pathname)) {
    response.setHeader('Content-Type', 'image/png'); response.end(png(Number(pathname.match(/\d+/)[0])));
  } else {
    response.setHeader('Content-Type', 'text/html'); response.end(pageSource);
  }
});

class CDP {
  constructor(socket) {
    this.socket = socket; this.nextId = 0; this.pending = new Map(); this.eventListeners = new Set();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result ?? {});
      } else {
        if (message.method?.startsWith('Target.')) result.browserEvents.push({at: new Date().toISOString(), method: message.method, params: message.params});
        for (const listener of this.eventListeners) listener(message);
      }
    });
    socket.addEventListener('close', () => {
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP socket closed')); }
      this.pending.clear();
    });
  }
  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  send(method, params = {}, sessionId, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      this.socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });
  }
  async evaluate(expression, sessionId, timeoutMs = 15000) {
    const reply = await this.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId, timeoutMs);
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  }
}

let browserProcess, cdp, sessionId, installed = false, profile, expectedAssetInventory;
try {
  await fs.mkdir(path.dirname(output), {recursive: true});
  if (Object.hasOwn(flags, 'expected-assets')) {
    if (typeof flags['expected-assets'] !== 'string' || !flags['expected-assets']) throw new Error('--expected-assets requires a nonempty inventory path');
    result.extensionAssets = {expectedManifestPath: path.resolve(flags['expected-assets']), matchedBefore: false, matchedAfter: false};
    const inventoryBytes = await fs.readFile(result.extensionAssets.expectedManifestPath);
    result.extensionAssets.expectedManifestSha256 = createHash('sha256').update(inventoryBytes).digest('hex');
    expectedAssetInventory = JSON.parse(inventoryBytes);
    try {
      result.extensionAssets.before = await verifyExtensionAssetInventory(result.extensionPath, expectedAssetInventory);
      Object.assign(result.extensionAssets, {matchedBefore: true, checkedFileCount: result.extensionAssets.before.checkedFileCount, backgroundSha256: result.extensionAssets.before.backgroundSha256, uiSha256: result.extensionAssets.before.uiSha256, manifestSha256: result.extensionAssets.before.manifestSha256});
    } catch (error) { result.extensionAssets.before = error.assetCheck ?? null; result.extensionAssets.beforeError = String(error); throw error; }
  }
  result.extensionManifest = JSON.parse(await fs.readFile(path.join(result.extensionPath, 'manifest.json'), 'utf8'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  result.origin = origin; result.manifestId = origin + '/';
  await fs.mkdir(path.join(here, 'profile'), {recursive: true});
  profile = await fs.mkdtemp(path.join(here, 'profile', 'run-'));
  result.profile = profile;
  result.cleanup.profileIsolated = path.dirname(profile) === path.join(here, 'profile');
  const browserLog = await fs.open(output + '.browser.log', 'w');
  result.browserFlags = ['--user-data-dir=' + profile, '--remote-debugging-pipe', '--enable-devtools-pwa-handler', '--no-first-run', '--no-default-browser-check', ...(flags['no-sandbox'] === 'true' ? ['--no-sandbox'] : []), '--disable-extensions-except=' + path.resolve(flags.extension), '--load-extension=' + path.resolve(flags.extension), 'about:blank'];
  browserProcess = spawn(path.resolve(flags.browser), result.browserFlags, {stdio: ['ignore', browserLog.fd, browserLog.fd, 'pipe', 'pipe']});
  browserProcess.once('error', error => { result.browserSpawnError = String(error); });
  browserProcess.once('exit', (code, signal) => { result.cleanup.childExit = {at: new Date().toISOString(), code, signal}; });
  // PWA commands are privileged and require the pipe transport. This raw CDP
  // client never enables auto-attach to extension service workers.
  const socket = new EventTarget();
  let pipeBuffer = Buffer.alloc(0);
  socket.send = text => browserProcess.stdio[3].write(text + '\0');
  socket.close = () => browserProcess.stdio[3].end();
  browserProcess.stdio[3].on('error', () => socket.dispatchEvent(new Event('close')));
  browserProcess.stdio[4].on('data', chunk => {
    pipeBuffer = Buffer.concat([pipeBuffer, chunk]);
    let end;
    while ((end = pipeBuffer.indexOf(0)) !== -1) {
      const packet = pipeBuffer.subarray(0, end).toString();
      pipeBuffer = pipeBuffer.subarray(end + 1);
      if (packet) socket.dispatchEvent(new MessageEvent('message', {data: packet}));
    }
  });
  browserProcess.stdio[4].on('error', () => socket.dispatchEvent(new Event('close')));
  browserProcess.stdio[4].on('close', () => socket.dispatchEvent(new Event('close')));
  browserProcess.once('exit', () => socket.dispatchEvent(new Event('close')));
  cdp = new CDP(socket);
  result.browserVersion = await cdp.send('Browser.getVersion', {}, undefined, 60000);
  await cdp.send('Target.setDiscoverTargets', {discover: true});
  let rabbyWorker;
  for (let attempt = 0; attempt < 300; attempt++) {
    rabbyWorker = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension://') && new URL(target.url).pathname === '/' + result.extensionManifest.background.service_worker);
    if (rabbyWorker) break;
    await sleep(100);
  }
  if (!rabbyWorker) throw new Error('Rabby service worker did not start');
  result.extensionId = new URL(rabbyWorker.url).host;
  // A fresh install registers its MAIN-world provider asynchronously. Wait for
  // that registration before navigating the test page; no worker debugger is attached.
  const bootstrapTarget = await cdp.send('Target.createTarget', {url: 'chrome-extension://' + result.extensionId + '/reliability-probe.html'});
  const bootstrapSession = (await cdp.send('Target.attachToTarget', {targetId: bootstrapTarget.targetId, flatten: true})).sessionId;
  let registered = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    registered = await cdp.evaluate('(async () => !!globalThis.chrome?.scripting && (await chrome.scripting.getRegisteredContentScripts()).some(script => script.js?.includes("pageProvider.js")))()', bootstrapSession);
    if (registered) break;
    await sleep(100);
  }
  result.providerRegisteredBeforeNavigation = registered;
  if (!registered) throw new Error('Rabby did not register its MAIN-world page provider');
  await cdp.evaluate(`(() => {
    const port = chrome.runtime.connect({name: 'tab'});
    window.__uiProbe = {ready: false, responses: {}, messages: [], disconnected: false, port};
    port.onMessage.addListener(message => {
      window.__uiProbe.messages.push(message);
      if (message._type_ === 'ETH_WALLET_message' && message.data?.event === 'RABBY_BACKGROUND_READY') window.__uiProbe.ready = true;
      if (message._type_ === 'ETH_WALLET_response') window.__uiProbe.responses[message.data.ident] = message.data;
    });
    port.onDisconnect.addListener(() => {window.__uiProbe.disconnected = true;});
    return true;
  })()`, bootstrapSession);
  const waitForUI = async (expression, label) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const response = await cdp.evaluate(expression, bootstrapSession);
      if (response) return response;
      await sleep(500);
    }
    result.bootstrapDiagnostics = await cdp.evaluate('({href: location.href, state: window.__uiProbe && {ready:__uiProbe.ready, messages:__uiProbe.messages, disconnected:__uiProbe.disconnected}})', bootstrapSession);
    throw new Error('UI setup timed out: ' + label);
  };
  await waitForUI('window.__uiProbe.ready', 'background ready');
  const uiCall = async (method, params = []) => {
    const ident = 'probe-' + method;
    await cdp.evaluate('window.__uiProbe.port.postMessage(' + JSON.stringify({_type_: 'ETH_WALLET_request', data: {ident, data: {type: 'controller', method, params}}}) + ')', bootstrapSession);
    const reply = await waitForUI('window.__uiProbe.responses[' + JSON.stringify(ident) + ']', method);
    if (reply.err) throw new Error('UI controller error: ' + JSON.stringify(reply.err));
    return reply.res;
  };
  const alreadyBooted = await uiCall('isBooted');
  if (alreadyBooted) throw new Error('Fresh profile unexpectedly already booted');
  await uiCall('boot', ['DisposableLocalProbe-' + Date.now()]);
  const accounts = await uiCall('importWatchAddress', ['0x0000000000000000000000000000000000000001']);
  result.watchOnlySetup = {alreadyBooted, accounts};
  if (!Array.isArray(accounts) || accounts.length !== 1 || accounts[0].address?.toLowerCase() !== '0x0000000000000000000000000000000000000001' || accounts[0].type !== 'Watch Address') throw new Error('Unexpected watch-only setup: ' + JSON.stringify(accounts));
  await cdp.evaluate('window.__uiProbe.port.disconnect()', bootstrapSession);
  await cdp.send('Target.detachFromTarget', {sessionId: bootstrapSession});
  await cdp.send('Target.closeTarget', {targetId: bootstrapTarget.targetId});
  console.log(JSON.stringify({stage:'watch-only-setup-complete', at:new Date().toISOString()}));
  if (result.uiSmoke.requested) {
    const smoke = result.uiSmoke;
    smoke.passed = false;
    smoke.startedAt = new Date().toISOString();
    smoke.timeoutMs = 30000;
    smoke.samples = [];
    smoke.uncaughtExceptions = [];
    smoke.consoleErrors = [];
    smoke.closedUiTargets = [];
    let uiSessionId;
    let unsubscribe = () => {};
    let smokeError;
    const smokeTarget = await cdp.send('Target.createTarget', {url: 'about:blank'});
    smoke.targetId = smokeTarget.targetId;
    const uiStateExpression = `(() => {
      const visible = element => {
        if (!element) return false;
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
      };
      const dashboard = document.querySelector('#root .dashboard');
      const address = document.querySelector('.dashboard .address-viewer-text[title="0x0000000000000000000000000000000000000001"]');
      const panels = Array.from(document.querySelectorAll('.dashboard .rabby-dashboard-panel-container .dashboard-panel-grid .panel-item.group'));
      const errorHeadings = Array.from(document.querySelectorAll('h2')).map(element => element.textContent.trim()).filter(text => text === 'Something went wrong' || text === 'Rabby failed to start');
      return {at: new Date().toISOString(), href: location.href, hash: location.hash, readyState: document.readyState, visibility: document.visibilityState, title: document.title, dashboardVisible: visible(dashboard), watchAddressVisible: visible(address), enabledPanelsVisible: panels.filter(visible).length, errorHeadings, bodyText: document.body?.innerText?.slice(0,12000) ?? ''};
    })()`;
    try {
      uiSessionId = (await cdp.send('Target.attachToTarget', {targetId: smokeTarget.targetId, flatten: true})).sessionId;
      unsubscribe = cdp.onEvent(message => {
        if (message.sessionId !== uiSessionId) return;
        if (message.method === 'Runtime.exceptionThrown') smoke.uncaughtExceptions.push({at: new Date().toISOString(), details: message.params.exceptionDetails});
        if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') smoke.consoleErrors.push({at: new Date().toISOString(), args: message.params.args.map(arg => ({type: arg.type, value: arg.value, description: arg.description})), stackTrace: message.params.stackTrace});
      });
      await cdp.send('Runtime.enable', {}, uiSessionId);
      await cdp.send('Page.enable', {}, uiSessionId);
      await cdp.send('Page.navigate', {url: 'chrome-extension://' + result.extensionId + '/index.html#/'}, uiSessionId);
      await cdp.send('Page.bringToFront', {}, uiSessionId);
      const started = performance.now();
      const deadline = started + smoke.timeoutMs;
      for (;;) {
        const state = await cdp.evaluate(uiStateExpression, uiSessionId);
        smoke.finalSnapshot = state;
        const {bodyText, ...sample} = state;
        smoke.samples.push({...sample, elapsedMs: performance.now() - started});
        if (state.errorHeadings.length) throw new Error('Real wallet UI rendered an error fallback: ' + state.errorHeadings.join(', '));
        if (smoke.uncaughtExceptions.length) throw new Error('Real wallet UI raised an uncaught JavaScript exception');
        const ready = state.readyState === 'complete' && state.visibility === 'visible' && state.hash === '#/dashboard' && state.dashboardVisible && state.watchAddressVisible && state.enabledPanelsVisible >= 1;
        if (ready && performance.now() <= deadline) { smoke.renderedAt = new Date().toISOString(); break; }
        if (performance.now() >= deadline) throw new Error('Real wallet UI did not render its visible watch-only dashboard within thirty seconds');
        await sleep(Math.min(100, Math.ceil(deadline - performance.now())));
      }
    } catch (error) { smokeError = error; smoke.error = String(error); }
    finally {
      if (uiSessionId) {
        try {
          smoke.finalSnapshot = await cdp.evaluate(uiStateExpression, uiSessionId);
          smoke.dom = output + '.ui-smoke.html';
          await fs.writeFile(smoke.dom, await cdp.evaluate('document.documentElement.outerHTML', uiSessionId));
          const screenshot = await cdp.send('Page.captureScreenshot', {format: 'png'}, uiSessionId);
          smoke.screenshot = output + '.ui-smoke.png';
          await fs.writeFile(smoke.screenshot, Buffer.from(screenshot.data, 'base64'));
        } catch (error) { smoke.captureError = String(error); smokeError ??= error; }
        unsubscribe();
        try { await cdp.send('Target.detachFromTarget', {sessionId: uiSessionId}); } catch (error) { smoke.detachError = String(error); smokeError ??= error; }
      }
      const ownUiPage = target => {
        if (target.type !== 'page') return false;
        try {
          const url = new URL(target.url);
          return url.protocol === 'chrome-extension:' && url.host === result.extensionId && ['/index.html', '/popup.html', '/welcome.html'].includes(url.pathname);
        } catch { return false; }
      };
      try {
        const ownUiTargets = (await cdp.send('Target.getTargets')).targetInfos.filter(target => target.targetId === smokeTarget.targetId || ownUiPage(target));
        for (const target of ownUiTargets) {
          const closeResult = await cdp.send('Target.closeTarget', {targetId: target.targetId});
          smoke.closedUiTargets.push({targetId: target.targetId, url: target.url, closeResult});
          if (!closeResult.success) throw new Error('Browser did not confirm closure of wallet UI target ' + target.targetId);
        }
        const cleanupStarted = performance.now();
        const cleanupDeadline = cleanupStarted + 5000;
        smoke.uiClosureSamples = [];
        for (;;) {
          smoke.remainingUiTargets = (await cdp.send('Target.getTargets')).targetInfos.filter(target => target.targetId === smokeTarget.targetId || ownUiPage(target)).map(target => ({targetId: target.targetId, url: target.url}));
          for (const target of smoke.closedUiTargets) target.targetDestroyedObserved = result.browserEvents.some(event => event.method === 'Target.targetDestroyed' && event.params.targetId === target.targetId);
          smoke.uiClosureSamples.push({at: new Date().toISOString(), elapsedMs: performance.now() - cleanupStarted, remainingTargetIds: smoke.remainingUiTargets.map(target => target.targetId), destroyedTargetIds: smoke.closedUiTargets.filter(target => target.targetDestroyedObserved).map(target => target.targetId)});
          if (!smoke.remainingUiTargets.length && smoke.closedUiTargets.every(target => target.targetDestroyedObserved)) break;
          if (performance.now() >= cleanupDeadline) throw new Error('Wallet UI target destruction was not confirmed within five seconds before lifecycle measurement');
          await sleep(Math.min(20, Math.ceil(cleanupDeadline - performance.now())));
        }
      } catch (error) { smoke.cleanupError = String(error); smokeError ??= error; }
      smoke.finishedAt = new Date().toISOString();
    }
    if (smoke.uncaughtExceptions.length) smokeError ??= new Error('Real wallet UI raised an uncaught JavaScript exception');
    if (smokeError) throw smokeError;
    smoke.passed = true;
    console.log(JSON.stringify({stage:'real-wallet-ui-smoke-complete', at:new Date().toISOString()}));
  }
  const normalTarget = await cdp.send('Target.createTarget', {url: origin + '/'});
  result.regularControl = {targetId: normalTarget.targetId, observations: []};
  sessionId = (await cdp.send('Target.attachToTarget', {targetId: normalTarget.targetId, flatten: true})).sessionId;
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.bringToFront', {}, sessionId);
  for (let n = 0; n < 300; n++) {
    if (await cdp.evaluate('!!window.__rabbyProbe && window.__rabbyProbe.snapshot().hasRabby', sessionId)) break;
    await sleep(100);
  }
  result.regularControl.pageState = await cdp.evaluate('({href:location.href, readyState:document.readyState, secure:isSecureContext, serviceWorker:!!navigator.serviceWorker, title:document.title, body:document.body?.innerText?.slice(0,1000), probe:window.__rabbyProbe?.snapshot()})', sessionId);
  result.regularControl.before = result.regularControl.pageState.probe;
  if (!result.regularControl.before?.hasRabby) throw new Error('Rabby provider was not injected into regular control tab: ' + JSON.stringify(result.regularControl.pageState));
  await cdp.evaluate('navigator.serviceWorker.ready.then(() => true)', sessionId);
  result.regularControl.initialSetup = await cdp.evaluate('window.__rabbyProbe.waitForInitialReady(5000)', sessionId);
  if (result.regularControl.initialSetup.status !== 'ready') throw new Error('Regular control initial-page setup did not become ready within five seconds');
  result.regularControl.before = result.regularControl.initialSetup.finalSnapshot;
  result.regularControl.observations.push(await cdp.evaluate('window.__rabbyProbe.request("control-before", ' + requestTimeoutMs + ')', sessionId, requestTimeoutMs + 5000));
  if (!validResponse(result.regularControl.observations[0])) throw new Error('Regular control baseline eth_chainId did not return a valid response; lifecycle test not started');
  result.installability = await cdp.send('Page.getInstallabilityErrors', {}, sessionId).catch(error => ({error: String(error)}));
  await cdp.send('Target.detachFromTarget', {sessionId}); sessionId = undefined;
  result.installAttempted = true;
  await cdp.send('PWA.install', {manifestId: result.manifestId, installUrlOrBundleUrl: origin + '/'});
  installed = true;
  await cdp.send('PWA.changeAppUserSettings', {manifestId: result.manifestId, displayMode: 'standalone'});
  result.pwaLaunch = await cdp.send('PWA.launch', {manifestId: result.manifestId, url: origin + '/?surface=pwa'});
  // Current Chrome returns a tab target from PWA.launch. Page/Runtime commands
  // belong to its page target, whose unique launch URL identifies it here.
  let pwaPage;
  for (let attempt = 0; attempt < 100; attempt++) {
    const pages = (await cdp.send('Target.getTargets')).targetInfos.filter(target => target.type === 'page' && target.url === origin + '/?surface=pwa');
    if (pages.length === 1) {pwaPage = pages[0]; break;}
    await sleep(100);
  }
  if (!pwaPage) throw new Error('PWA page target was not uniquely identified');
  const targetId = pwaPage.targetId;
  result.pwaPageTarget = pwaPage;
  sessionId = (await cdp.send('Target.attachToTarget', {targetId, flatten: true})).sessionId;
  await cdp.send('Page.enable', {}, sessionId);
  for (let n = 0; n < 150; n++) {
    const ready = await cdp.evaluate('!!window.__rabbyProbe && window.__rabbyProbe.snapshot().hasRabby', sessionId);
    if (ready) break;
    await sleep(100);
  }
  await cdp.send('Page.bringToFront', {}, sessionId);
  result.initialSetup = await cdp.evaluate('window.__rabbyProbe.waitForInitialReady(5000)', sessionId);
  if (result.initialSetup.status !== 'ready') throw new Error('PWA initial-page setup did not become ready within five seconds');
  result.before = result.initialSetup.finalSnapshot;
  if (!result.before.standalone) throw new Error('PWA did not launch in standalone display mode');
  if (result.before.href !== origin + '/?surface=pwa') throw new Error('PWA did not honor the unique launch URL');
  if (!result.before.hasRabby) throw new Error('Rabby provider was not injected into installed PWA');
  result.observations.push(await cdp.evaluate('window.__rabbyProbe.request("before", ' + requestTimeoutMs + ')', sessionId, requestTimeoutMs + 5000));
  if (!validResponse(result.observations[0])) throw new Error('Baseline eth_chainId did not return a valid response; lifecycle test not started');
  const beforeTargets = await cdp.send('Target.getTargets');
  const extensionWorkers = beforeTargets.targetInfos.filter(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension://') && new URL(target.url).pathname === '/' + result.extensionManifest.background.service_worker);
  result.extensionWorkersBeforeWait = extensionWorkers;
  const extensionIds = [...new Set(extensionWorkers.map(target => new URL(target.url).host))];
  if (extensionIds.length === 1) result.extensionId = extensionIds[0];
  if (mode === 'natural') {
    const controlClose = await cdp.send('Target.closeTarget', {targetId: normalTarget.targetId});
    result.regularControl.closedBeforeNaturalWait = controlClose.success;
    result.regularControl.afterApplicable = false;
    result.regularControl.skipReason = 'Closed before natural wait so a same-origin regular tab cannot affect PWA freezing heuristics.';
    if (!controlClose.success) throw new Error('Browser did not confirm regular control tab closure before natural wait');
  } else {
    result.regularControl.retainedDuringWait = true;
    result.regularControl.afterApplicable = true;
  }
  const windowInfo = await cdp.send('Browser.getWindowForTarget', {targetId});
  result.windowBefore = windowInfo;
  await cdp.send('Browser.setWindowBounds', {windowId: windowInfo.windowId, bounds: {windowState: 'minimized'}});
  for (let attempt = 0; attempt < 30; attempt++) {
    result.windowMinimized = await cdp.send('Browser.getWindowBounds', {windowId: windowInfo.windowId});
    if (result.windowMinimized.bounds.windowState === 'minimized') break;
    await sleep(100);
  }
  result.minimizeConfirmed = result.windowMinimized.bounds.windowState === 'minimized';
  if (!result.minimizeConfirmed && mode !== 'worker-stop') throw new Error('Browser did not confirm minimized native window');
  if (!result.minimizeConfirmed) result.minimizeLimitation = 'Native minimize was not confirmed; this run tests worker-restart recovery in a standalone PWA, not minimize/resume.';
  if (mode === 'freeze') await cdp.send('Page.setWebLifecycleState', {state: 'frozen'}, sessionId);
  await cdp.send('Target.detachFromTarget', {sessionId}); sessionId = undefined;
  result.detachedAt = new Date().toISOString();
  if (mode === 'worker-stop') {
    const {targetInfos} = await cdp.send('Target.getTargets');
    const workers = targetInfos.filter(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension://' + result.extensionId + '/'));
    result.stoppedWorkers = [];
    if (workers.length !== 1) throw new Error('Expected exactly one extension service worker target to terminate, found ' + workers.length);
    for (const worker of workers) {
      const closeResult = await cdp.send('Target.closeTarget', {targetId: worker.targetId});
      result.stoppedWorkers.push({target: worker, closeResult});
      if (!closeResult.success) throw new Error('Browser did not confirm worker target closure');
      for (let attempt = 0; attempt < 30; attempt++) {
        if (result.browserEvents.some(event => event.method === 'Target.targetDestroyed' && event.params.targetId === worker.targetId)) break;
        await sleep(100);
      }
      const destroyed = result.browserEvents.some(event => event.method === 'Target.targetDestroyed' && event.params.targetId === worker.targetId);
      result.stoppedWorkers.at(-1).targetDestroyedObserved = destroyed;
      if (!destroyed) throw new Error('Worker closure was acknowledged but target destruction was not observed');
    }
  }
  console.log(JSON.stringify({stage:'detached-minimized-wait', mode, waitMs, at:new Date().toISOString()}));
  result.waitStartedAt = new Date().toISOString();
  const waitedAt = performance.now();
  // A timer can wake fractionally early; measure and enforce the full interval.
  const waitDeadline = waitedAt + waitMs;
  while (performance.now() < waitDeadline) {
    await sleep(Math.ceil(waitDeadline - performance.now()));
  }
  result.actualDetachedWaitMs = performance.now() - waitedAt;
  result.waitFinishedAt = new Date().toISOString();
  await cdp.send('Browser.setWindowBounds', {windowId: windowInfo.windowId, bounds: {windowState: 'normal'}});
  for (let attempt = 0; attempt < 30; attempt++) {
    result.windowRestoredBeforeAttachment = await cdp.send('Browser.getWindowBounds', {windowId: windowInfo.windowId});
    if (result.windowRestoredBeforeAttachment.bounds.windowState === 'normal') break;
    await sleep(100);
  }
  if (result.windowRestoredBeforeAttachment.bounds.windowState !== 'normal') throw new Error('Native PWA window did not restore before debugger attachment');
  result.nativeRestoredAt = new Date().toISOString();
  sessionId = (await cdp.send('Target.attachToTarget', {targetId, flatten: true})).sessionId;
  result.reattachedAt = new Date().toISOString();
  if (mode === 'freeze') await cdp.send('Page.setWebLifecycleState', {state: 'active'}, sessionId);
  await cdp.send('Page.bringToFront', {}, sessionId);
  for (let attempt = 0; attempt < 30; attempt++) {
    result.windowRestored = await cdp.send('Browser.getWindowBounds', {windowId: windowInfo.windowId});
    result.restoredVisibility = await cdp.evaluate('document.visibilityState', sessionId);
    if (result.windowRestored.bounds.windowState === 'normal' && result.restoredVisibility === 'visible') break;
    await sleep(100);
  }
  if (result.windowRestored.bounds.windowState !== 'normal' || result.restoredVisibility !== 'visible') throw new Error('PWA window was not restored and visible before measuring');
  for (let n = 1; n <= 3; n++) result.observations.push(await cdp.evaluate('window.__rabbyProbe.request("after-' + n + '", ' + requestTimeoutMs + ')', sessionId, requestTimeoutMs + 5000));
  result.after = await cdp.evaluate('window.__rabbyProbe.snapshot()', sessionId);
  result.sameDocument = result.before.loadId === result.after.loadId;
  result.status = !result.sameDocument ? 'document-reloaded' : result.observations.every(item => sameResponse(item, result.observations[0])) ? 'responses-settled-without-reload' : 'request-failure-observed';
  try {
    const screenshot = await cdp.send('Page.captureScreenshot', {format: 'png'}, sessionId);
    result.screenshot = output + '.png';
    await fs.writeFile(result.screenshot, Buffer.from(screenshot.data, 'base64'));
  } catch (error) { result.screenshotError = String(error); }
  let controlSessionId;
  if (result.regularControl.afterApplicable) try {
    controlSessionId = (await cdp.send('Target.attachToTarget', {targetId: normalTarget.targetId, flatten: true})).sessionId;
    result.regularControl.windowBeforeMeasurements = await cdp.send('Browser.getWindowForTarget', {targetId: normalTarget.targetId});
    await cdp.send('Browser.setWindowBounds', {windowId: result.regularControl.windowBeforeMeasurements.windowId, bounds: {windowState: 'normal'}});
    await cdp.send('Page.bringToFront', {}, controlSessionId);
    for (let attempt = 0; attempt < 30; attempt++) {
      result.regularControl.restoredVisibility = await cdp.evaluate('document.visibilityState', controlSessionId);
      if (result.regularControl.restoredVisibility === 'visible') break;
      await sleep(100);
    }
    if (result.regularControl.restoredVisibility !== 'visible') throw new Error('Regular control was not visible before measuring');
    result.regularControl.visibleBeforeMeasurementsAt = new Date().toISOString();
    result.regularControl.beforeMeasurementSnapshot = await cdp.evaluate('window.__rabbyProbe.snapshot()', controlSessionId);
    for (let n = 1; n <= 3; n++) result.regularControl.observations.push(await cdp.evaluate('window.__rabbyProbe.request("control-after-' + n + '", ' + requestTimeoutMs + ')', controlSessionId, requestTimeoutMs + 5000));
    result.regularControl.after = await cdp.evaluate('window.__rabbyProbe.snapshot()', controlSessionId);
    result.regularControl.sameDocument = result.regularControl.before.loadId === result.regularControl.after.loadId;
    result.regularControl.status = !result.regularControl.sameDocument ? 'document-reloaded' : result.regularControl.observations.every(item => sameResponse(item, result.regularControl.observations[0])) ? 'responses-settled-without-reload' : 'request-failure-observed';
  } catch (error) { result.regularControl.error = String(error); }
  finally {
    if (controlSessionId) {
      try { await cdp.send('Target.detachFromTarget', {sessionId: controlSessionId}); } catch {}
    }
  }
  let inspectionTargetId;
  try {
    if (!result.extensionId) throw new Error('Could not identify exactly one extension id from the pre-wait service-worker targets');
    inspectionTargetId = (await cdp.send('Target.createTarget', {url: 'chrome-extension://' + result.extensionId + '/popup.html'})).targetId;
    const inspectionSession = (await cdp.send('Target.attachToTarget', {targetId: inspectionTargetId, flatten: true})).sessionId;
    let inspectionReady = false;
    for (let n = 0; n < 50; n++) {
      inspectionReady = await cdp.evaluate('!!globalThis.chrome?.windows?.getAll && !!globalThis.chrome?.tabs?.query', inspectionSession);
      if (inspectionReady) break;
      await sleep(100);
    }
    if (!inspectionReady) throw new Error('Extension popup page did not expose chrome.windows and chrome.tabs');
    result.afterObservationInspection = await cdp.evaluate(`(async () => {
      const origin = ${JSON.stringify(origin)};
      const windows = await chrome.windows.getAll({populate: true});
      const all = await chrome.tabs.query({url: '<all_urls>'});
      const normal = await chrome.tabs.query({url: '<all_urls>', windowType: 'normal'});
      const tabView = tab => ({id: tab.id, windowId: tab.windowId, active: tab.active, discarded: tab.discarded, url: tab.url ?? null});
      const matchesOrigin = tab => { try { const url = new URL(tab.url); return url.origin === origin && url.searchParams.get('surface') === 'pwa'; } catch { return false; } };
      return {at: new Date().toISOString(), windows: windows.map(win => ({id: win.id, type: win.type, state: win.state, focused: win.focused, tabs: (win.tabs ?? []).map(tabView)})), tabsAllUrls: all.map(tabView), tabsNormalWindows: normal.map(tabView), pwaTabIdsAllUrls: all.filter(matchesOrigin).map(tab => tab.id), pwaTabIdsNormalWindows: normal.filter(matchesOrigin).map(tab => tab.id)};
    })()`, inspectionSession);
    await cdp.send('Target.detachFromTarget', {sessionId: inspectionSession});
  } catch (error) { result.afterObservationInspectionError = String(error); }
  finally {
    if (inspectionTargetId) {
      try { await cdp.send('Target.closeTarget', {targetId: inspectionTargetId}); } catch {}
    }
  }
} catch (error) {
  result.status = 'harness-error'; result.error = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  if (cdp && sessionId) {
    try { await cdp.send('Page.setWebLifecycleState', {state: 'active'}, sessionId, 3000); } catch {}
  }
  if (cdp && (installed || result.installAttempted)) {
    try { await cdp.send('PWA.uninstall', {manifestId: result.manifestId}, undefined, 10000); result.cleanup.pwaUninstalled = true; }
    catch (error) { result.cleanup.pwaUninstalled = false; result.cleanup.pwaUninstallError = String(error); }
  }
  if (cdp) {
    result.cleanup.browserCloseRequested = true;
    try { await cdp.send('Browser.close', {}, undefined, 3000); } catch {}
    cdp.socket.close();
  }
  if (browserProcess && browserProcess.exitCode === null) {
    const ended = await Promise.race([new Promise(resolve => browserProcess.once('exit', () => resolve(true))), sleep(3000).then(() => false)]);
    if (!ended) {
      result.cleanup.sigtermRequested = browserProcess.kill('SIGTERM');
      const terminated = await Promise.race([new Promise(resolve => browserProcess.once('exit', () => resolve(true))), sleep(3000).then(() => false)]);
      if (!terminated) {
        result.cleanup.sigkillRequested = browserProcess.kill('SIGKILL');
        await Promise.race([new Promise(resolve => browserProcess.once('exit', resolve)), sleep(3000)]);
      }
    }
  }
  result.cleanup.childExitObserved = !!result.cleanup.childExit;
  if (result.extensionAssets?.matchedBefore) {
    try {
      if (!result.cleanup.childExitObserved) throw new Error('Browser child exit must be confirmed before the final asset check');
      const inventoryBytes = await fs.readFile(result.extensionAssets.expectedManifestPath);
      const afterManifestSha256 = createHash('sha256').update(inventoryBytes).digest('hex');
      result.extensionAssets.expectedManifestSha256After = afterManifestSha256;
      if (afterManifestSha256 !== result.extensionAssets.expectedManifestSha256) throw new Error('Expected asset inventory file changed during the browser run');
      result.extensionAssets.after = await verifyExtensionAssetInventory(result.extensionPath, expectedAssetInventory);
      result.extensionAssets.matchedAfter = true;
    } catch (error) {
      result.extensionAssets.after = error.assetCheck ?? null;
      result.extensionAssets.afterError = String(error);
      result.status = 'harness-error';
      result.error = [result.error, 'Post-run extension asset check: ' + String(error)].filter(Boolean).join('\n');
      process.exitCode = 1;
    }
  }
  await new Promise(resolve => server.close(resolve));
  result.finishedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(output), {recursive: true});
  await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({status: result.status, mode, output, observations: result.observations.map(({label, status, elapsedMs}) => ({label, status, elapsedMs})), error: result.error ?? null}));
}
