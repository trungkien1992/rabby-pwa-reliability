#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// This checks recorded observations. It does not authenticate the browser,
// rebuild artifacts, or promote worker-stop evidence into natural-resume proof.
const files = process.argv.slice(2);
let checks = 0;
const output = {schema: 1, passed: false, checkedAt: new Date().toISOString(), checks: 0};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (condition, message) => {
  checks++;
  if (!condition) throw new Error(message);
};
const timestamp = value => {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  requireThat(Number.isFinite(parsed), 'Missing or invalid recorded timestamp: ' + String(value));
  return parsed;
};
const finiteDuration = value => Number.isFinite(value) && value >= 0;
const validChainId = value => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value);
const round = value => Math.round(value * 1000) / 1000;
const sourceEvent = event => event.params?.targetInfo;

function inspectRun(run, role) {
  const prefix = role + ': ';
  const check = (condition, message) => requireThat(condition, prefix + message);
  check(run.mode === 'worker-stop', 'expected the controlled worker-stop mode');
  check(['darwin', 'linux'].includes(run.platform) && typeof run.architecture === 'string', 'expected recorded macOS or Linux platform and architecture');
  check(typeof run.minimizeConfirmed === 'boolean', 'native minimization confirmation must be explicit');
  if (run.minimizeConfirmed) {
    check(run.windowMinimized?.bounds?.windowState === 'minimized', 'confirmed native minimization requires recorded minimized bounds');
  } else {
    check(typeof run.minimizeLimitation === 'string' && /not confirmed/i.test(run.minimizeLimitation) && /not minimize\/resume/i.test(run.minimizeLimitation), 'unconfirmed native minimization must retain the explicit scope limitation');
  }
  check(typeof run.proofScope === 'string' && /controlled/i.test(run.proofScope) && /not a natural Linux/i.test(run.proofScope), 'controlled lifecycle scope must be explicit');
  check(run.browserFlags?.includes('--remote-debugging-pipe'), 'raw pipe transport was not recorded');
  check(run.providerRegisteredBeforeNavigation === true && run.installAttempted === true, 'provider registration or PWA installation was not recorded');
  check(run.watchOnlySetup?.alreadyBooted === false, 'fresh isolated wallet setup was not established');
  const accounts = run.watchOnlySetup?.accounts;
  check(Array.isArray(accounts) && accounts.length === 1 && accounts[0].type === 'Watch Address' && accounts[0].address?.toLowerCase() === '0x0000000000000000000000000000000000000001', 'expected exactly the disclosed watch-only account');
  check(finiteDuration(run.waitMs) && run.waitMs > 0 && finiteDuration(run.actualDetachedWaitMs) && run.actualDetachedWaitMs >= run.waitMs, 'detached wait did not reach the configured duration');
  check(finiteDuration(run.requestTimeoutMs) && run.requestTimeoutMs > 0, 'missing request deadline');
  const observations = run.observations;
  check(run.observationTimingSchema === undefined || run.observationTimingSchema === 1, 'unknown observation timing schema');
  const hasRequestTimestamps = run.observationTimingSchema === 1;
  check(Array.isArray(observations) && observations.length === 4, 'expected one baseline plus three post-restart PWA observations');
  check(observations.map(item => item.label).join(',') === 'before,after-1,after-2,after-3', 'unexpected PWA observation labels or ordering');
  const baseline = observations[0];
  check(baseline.status === 'resolved' && validChainId(baseline.value), 'PWA baseline did not return a valid chain ID');
  check(baseline.snapshot?.waitingCount === 0, 'PWA baseline did not drain its pending requests');
  check(run.sameDocument === true && typeof run.before?.loadId === 'string' && run.before.loadId === run.after?.loadId, 'PWA document reloaded or identity is incomplete');
  const pwaUrl = new URL(run.before.href);
  check(pwaUrl.origin === run.origin && pwaUrl.searchParams.get('surface') === 'pwa' && run.after.href === run.before.href, 'PWA URL marker or document URL changed');
  for (const snapshot of [run.before, run.after, ...observations.map(item => item.snapshot)]) {
    check(snapshot?.loadId === run.before.loadId && snapshot.standalone === true && snapshot.hasRabby === true && snapshot.isConnected === true && snapshot.wasDiscarded === false, 'PWA standalone/provider/document state was not retained');
    check(snapshot.channel?.readable === true && snapshot.channel?.writable === true && snapshot.channel?.destroyed === false, 'expected the recorded healthy-looking provider channel');
  }
  for (const item of observations) check(finiteDuration(item.elapsedMs), 'invalid PWA request duration');
  if (role === 'baseline') {
    check(run.status === 'request-failure-observed', 'baseline summary does not identify the observed failure');
    for (const [index, item] of observations.slice(1).entries()) {
      check(item.status === 'deadline' && item.deadlineMs === run.requestTimeoutMs && item.elapsedMs >= item.deadlineMs, 'baseline post-restart request did not reach its deadline');
      check(item.snapshot.waitingCount === index + 1, 'baseline pending requests did not accumulate as 1, 2, 3');
    }
    check(run.after.waitingCount === 3, 'baseline final pending-request count is not three');
  } else {
    check(run.status === 'responses-settled-without-reload', 'candidate summary does not identify successful recovery');
    for (const item of observations.slice(1)) {
      check(item.status === 'resolved' && validChainId(item.value) && item.value === baseline.value && item.elapsedMs < run.requestTimeoutMs, 'candidate post-restart chain ID did not match baseline before its deadline');
      check(item.snapshot.waitingCount === 0, 'candidate retained pending requests after settlement');
    }
    check(run.after.waitingCount === 0, 'candidate final pending-request count is not zero');
  }
  const control = run.regularControl;
  check(control?.retainedDuringWait === true && control.afterApplicable === true && control.sameDocument === true && control.status === 'responses-settled-without-reload', 'regular-tab control was incomplete or failed');
  check(typeof control.before?.loadId === 'string' && control.before.loadId === control.after?.loadId && control.before.loadId !== run.before.loadId, 'control identity was not preserved separately');
  check(Array.isArray(control.observations) && control.observations.length === 4 && control.observations.map(item => item.label).join(',') === 'control-before,control-after-1,control-after-2,control-after-3', 'expected four ordered control observations');
  for (const item of control.observations) {
    check(item.status === 'resolved' && item.value === baseline.value && finiteDuration(item.elapsedMs) && item.elapsedMs < run.requestTimeoutMs && item.snapshot?.waitingCount === 0, 'regular control did not resolve the matching chain ID cleanly');
    check(item.snapshot.standalone === false && item.snapshot.loadId === control.before.loadId && item.snapshot.visibility === 'visible', 'control stopped being a separate visible regular document');
  }
  if (hasRequestTimestamps) {
    check(control.restoredVisibility === 'visible' && control.beforeMeasurementSnapshot?.visibility === 'visible', 'control visibility was not established before post-restart reads');
    const visibleAt = timestamp(control.visibleBeforeMeasurementsAt);
    check(visibleAt <= timestamp(control.observations[1].startedAt), 'control request started before visible-state confirmation');
    for (const item of [...observations, ...control.observations]) {
      const startedAt = timestamp(item.startedAt);
      const finishedAt = timestamp(item.finishedAt);
      check(finishedAt >= startedAt, 'request finish predates its start');
      const starts = item.snapshot.events?.filter(event => event.type === 'requestStarted' && event.label === item.label);
      const finishes = item.snapshot.events?.filter(event => event.type === 'requestFinished' && event.label === item.label);
      check(starts?.length === 1 && finishes?.length === 1 && timestamp(starts[0].at) >= startedAt && timestamp(finishes[0].at) <= finishedAt && timestamp(finishes[0].at) >= timestamp(starts[0].at) && finishes[0].status === item.status, 'request start/finish event evidence is incomplete or inconsistent');
      if (item.status === 'deadline') {
        const deadlines = item.snapshot.events.filter(event => event.type === 'requestDeadline' && event.label === item.label);
        check(deadlines.length === 1 && deadlines[0].deadlineMs === run.requestTimeoutMs && timestamp(deadlines[0].at) >= startedAt + run.requestTimeoutMs && timestamp(deadlines[0].at) <= finishedAt, 'request deadline event is missing or inconsistent');
      }
    }
  } else {
    check([...observations, ...control.observations].every(item => item.startedAt === undefined && item.finishedAt === undefined), 'legacy observation timestamps are partial or lack their schema marker');
  }
  const events = run.browserEvents;
  check(Array.isArray(events) && events.length > 0, 'browser target-event evidence is missing');
  for (const event of events) {
    if (sourceEvent(event)?.type === 'service_worker') {
      check(sourceEvent(event).attached === false && event.method !== 'Target.attachedToTarget', 'a service-worker debugger attachment was observed');
    }
  }
  const targetId = run.pwaPageTarget?.targetId;
  check(typeof targetId === 'string' && run.pwaPageTarget.type === 'page' && run.pwaPageTarget.url === run.before.href, 'actual PWA page target is missing or mismatched');
  const detachedAt = timestamp(run.detachedAt);
  const reattachedAt = timestamp(run.reattachedAt);
  const detachEvents = events.filter(event => event.method === 'Target.detachedFromTarget' && event.params?.targetId === targetId && timestamp(event.at) <= detachedAt);
  check(detachEvents.length > 0, 'PWA debugger detachment was not recorded');
  const lastDetach = detachEvents.at(-1);
  const attachments = events.filter(event => event.method === 'Target.attachedToTarget' && sourceEvent(event)?.targetId === targetId && timestamp(event.at) > detachedAt);
  check(attachments.length > 0, 'PWA post-wait debugger attachment was not recorded');
  const firstReattachment = timestamp(attachments[0].at);
  check(firstReattachment - detachedAt >= run.waitMs && Math.abs(firstReattachment - reattachedAt) <= 1000, 'PWA was attached before the wait completed or timestamps are inconsistent');
  check(timestamp(run.nativeRestoredAt) <= firstReattachment, 'native restoration was recorded after debugger reattachment');
  check(run.restoredVisibility === 'visible' && run.windowRestored?.bounds?.windowState === 'normal', 'PWA was not visible and restored before request measurements');
  const controlAttachmentsDuringWait = events.filter(event => event.method === 'Target.attachedToTarget' && sourceEvent(event)?.targetId === control.targetId && timestamp(event.at) > detachedAt && timestamp(event.at) < firstReattachment);
  check(controlAttachmentsDuringWait.length === 0, 'control debugger attached during the measured wait');
  const postPwaControlAttachments = events.filter(event => event.method === 'Target.attachedToTarget' && sourceEvent(event)?.targetId === control.targetId && timestamp(event.at) > firstReattachment);
  check(postPwaControlAttachments.length > 0, 'post-PWA control attachment bound is missing');
  const controlAttachmentAt = timestamp(postPwaControlAttachments[0].at);
  const firstReplies = observations[1].snapshot.events?.filter(event => event.type === 'requestResolved' && event.label === observations[1].label && event.value === baseline.value) ?? [];
  let firstReplyAt;
  if (role === 'candidate') {
    check(firstReplies.length === 1, 'candidate first successful PWA reply event is missing or ambiguous');
    firstReplyAt = timestamp(firstReplies[0].at);
    check(firstReplyAt >= firstReattachment && firstReplyAt < controlAttachmentAt, 'candidate first reply was outside the PWA measurement phase');
  }
  let measurementEndAt = controlAttachmentAt;
  let measurementEndSource = 'legacy-post-PWA-control-attachment-upper-bound';
  if (hasRequestTimestamps) {
    measurementEndAt = timestamp(observations.at(-1).finishedAt);
    measurementEndSource = 'absolute-final-PWA-request-finishedAt';
    check(timestamp(observations[1].startedAt) >= firstReattachment && measurementEndAt < controlAttachmentAt, 'PWA measurements overlap the regular-control attachment');
    for (let index = 1; index < observations.length; index++) {
      check(timestamp(observations[index].startedAt) >= timestamp(observations[index - 1].finishedAt), 'PWA request intervals are not sequential');
    }
  }
  const stopped = run.stoppedWorkers;
  check(Array.isArray(stopped) && stopped.length === 1, 'expected exactly one stopped Rabby worker');
  const worker = stopped[0];
  const expectedWorkerUrl = 'chrome-extension://' + run.extensionId + '/' + run.extensionManifest?.background?.service_worker;
  check(worker.target?.type === 'service_worker' && worker.target.url === expectedWorkerUrl && worker.target.attached === false && worker.closeResult?.success === true && worker.targetDestroyedObserved === true, 'wrong worker, attached worker, or unacknowledged termination');
  const beforeWorkers = run.extensionWorkersBeforeWait;
  check(Array.isArray(beforeWorkers) && beforeWorkers.length === 1 && beforeWorkers[0].targetId === worker.target.targetId && beforeWorkers[0].attached === false, 'stopped worker does not match the pre-wait Rabby worker');
  const destroyed = events.find(event => event.method === 'Target.targetDestroyed' && event.params?.targetId === worker.target.targetId && timestamp(event.at) >= timestamp(lastDetach.at) && timestamp(event.at) < firstReattachment);
  check(!!destroyed, 'exact stopped worker target was not destroyed during the detached interval');
  const destroyedAt = timestamp(destroyed.at);
  check(firstReattachment - destroyedAt >= run.waitMs, 'a full configured detached interval after worker destruction was not observed');
  let destructionTimingSource = 'legacy-destruction-to-reattachment-detached-gap';
  if (hasRequestTimestamps) {
    check(destroyedAt <= timestamp(run.waitStartedAt) && timestamp(run.waitFinishedAt) - timestamp(run.waitStartedAt) >= run.waitMs && timestamp(run.waitFinishedAt) <= firstReattachment, 'worker destruction or explicit wait interval ordering is invalid');
    destructionTimingSource = 'explicit-destruction-before-waitStartedAt';
  }
  const replacementUpperBound = role === 'candidate' ? Math.min(firstReplyAt, measurementEndAt) : measurementEndAt;
  const restarted = events.find(event => event.method === 'Target.targetCreated' && sourceEvent(event)?.type === 'service_worker' && sourceEvent(event).url === expectedWorkerUrl && sourceEvent(event).targetId !== worker.target.targetId && timestamp(event.at) >= destroyedAt && timestamp(event.at) < replacementUpperBound);
  check(!!restarted && sourceEvent(restarted).attached === false, 'a distinct unattached Rabby worker was not created before the bounded PWA measurement outcome');
  const replacementAt = timestamp(restarted.at);
  const query = run.afterObservationInspection;
  check(query && Array.isArray(query.windows) && Array.isArray(query.tabsAllUrls) && Array.isArray(query.tabsNormalWindows), 'window/tab query evidence is incomplete');
  const actualPwaTabs = query.tabsAllUrls.filter(tab => tab.url === run.before.href);
  check(actualPwaTabs.length === 1 && Number.isInteger(actualPwaTabs[0].id), 'all-URL query did not identify exactly the actual PWA tab');
  const pwaTab = actualPwaTabs[0];
  check(query.pwaTabIdsAllUrls?.length === 1 && query.pwaTabIdsAllUrls[0] === pwaTab.id && query.pwaTabIdsNormalWindows?.length === 0 && !query.tabsNormalWindows.some(tab => tab.id === pwaTab.id), 'normal-window query exclusion was not established');
  const pwaWindow = query.windows.find(window => window.id === pwaTab.windowId);
  check(['app', 'popup'].includes(pwaWindow?.type) && pwaWindow.tabs?.some(tab => tab.id === pwaTab.id && tab.url === run.before.href), 'actual PWA tab is not recorded in a non-normal app or popup window');
  check(pwaWindow.id === run.windowBefore?.windowId, 'inspected app window differs from the measured native PWA window');
  check(query.tabsNormalWindows.some(tab => tab.url === control.before.href), 'normal-window query did not include the regular control');
  const cleanup = run.cleanup;
  check(cleanup?.profileIsolated === true && cleanup.pwaUninstalled === true && cleanup.browserCloseRequested === true && cleanup.childExitObserved === true, 'isolated-profile cleanup acknowledgements are incomplete');
  check(cleanup.childExit?.code === 0 && cleanup.childExit.signal === null && !cleanup.sigtermRequested && !cleanup.sigkillRequested, 'browser child did not exit normally');
  check(timestamp(cleanup.childExit.at) <= timestamp(run.finishedAt), 'child exit was not recorded before result completion');
  return {
    status: run.status,
    platform: run.platform,
    browser: run.browserVersion?.product,
    extensionVersion: run.extensionManifest?.version,
    chainId: baseline.value,
    afterRequestMs: observations.slice(1).map(item => round(item.elapsedMs)),
    afterRequestOutcomes: observations.slice(1).map(item => item.status),
    afterWaitingCounts: observations.slice(1).map(item => item.snapshot.waitingCount),
    controlAfterRequestMs: control.observations.slice(1).map(item => round(item.elapsedMs)),
    workerDestroyed: worker.target.targetId,
    replacementWorker: sourceEvent(restarted).targetId,
    replacementCreatedAt: restarted.at,
    replacementRelativeToPwaReattachment: replacementAt < firstReattachment ? 'before' : 'at-or-after',
    replacementUpperBound: {at: new Date(replacementUpperBound).toISOString(), source: role === 'candidate' ? 'first-successful-PWA-requestResolved-event' : measurementEndSource},
    measurementEndBound: {at: new Date(measurementEndAt).toISOString(), source: measurementEndSource},
    destructionTimingSource,
    destroyedToPwaReattachmentMs: firstReattachment - destroyedAt,
    explicitRequestTimestamps: hasRequestTimestamps,
    workerDebuggerAttachments: 0,
    standalone: true,
    sameDocument: true,
    pwaWindowType: pwaWindow.type,
    pwaIncludedInAllUrlQuery: true,
    pwaExcludedFromNormalWindowQuery: true,
    nativeMinimizeConfirmed: run.minimizeConfirmed,
    pwaUninstallAcknowledged: true,
    browserChildExitCode: cleanup.childExit.code,
  };
}

try {
  requireThat(files.length === 2, 'Usage: node verify-results.mjs BASELINE.json CANDIDATE.json');
  output.verifierSha256 = sha256(await fs.readFile(fileURLToPath(import.meta.url)));
  const inputs = await Promise.all(files.map(async file => {
    const bytes = await fs.readFile(path.resolve(file));
    return {file: path.basename(file), sha256: sha256(bytes), run: JSON.parse(bytes)};
  }));
  output.inputs = inputs.map(({file, sha256}) => ({file, sha256}));
  output.baseline = inspectRun(inputs[0].run, 'baseline');
  output.candidate = inspectRun(inputs[1].run, 'candidate');
  const [baseline, candidate] = inputs.map(input => input.run);
  for (const field of ['platform', 'architecture', 'mode', 'waitMs', 'requestTimeoutMs', 'minimizeConfirmed']) requireThat(baseline[field] === candidate[field], 'Pair differs in comparison setting: ' + field);
  for (const field of ['product', 'revision', 'protocolVersion']) requireThat(baseline.browserVersion?.[field] && baseline.browserVersion[field] === candidate.browserVersion?.[field], 'Pair differs in browser setting: ' + field);
  requireThat(baseline.extensionManifest?.version && baseline.extensionManifest.version === candidate.extensionManifest?.version, 'Extension versions differ');
  requireThat(output.baseline.chainId === output.candidate.chainId, 'Baseline and candidate chain IDs differ');
  requireThat(baseline.profile !== candidate.profile, 'Baseline and candidate did not use separate isolated profiles');
  const platformName = baseline.platform === 'darwin' ? 'macOS' : 'Linux';
  const minimizeScope = baseline.minimizeConfirmed ? 'Native minimization was confirmed; worker termination was still forced.' : 'Native minimization was unconfirmed.';
  output.scope = `One paired ${platformName} standalone-PWA worker-stop experiment. ${minimizeScope} Verifies recorded outcomes only; no natural Linux minimize/resume or production performance claim.`;
  output.passed = true;
} catch (error) {
  output.error = String(error?.message || error);
  process.exitCode = 1;
}
output.checks = checks;
console.log(JSON.stringify(output, null, 2));
