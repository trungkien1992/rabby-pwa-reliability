# Full source production validation

This experiment closes the packaging gap left by the earlier background-only
hybrid. It builds the entire extension twice with the upstream `build:pro`
command: background, UI, content script, page provider and offscreen entry.
Production Warden enforcement, minification, shared chunks, HTML and copied
runtime/vendor assets remain enabled. No released extension files are inputs.

The [manual workflow](../.github/workflows/full-source.yml) first installs the
pinned dependencies with Yarn 4.14.1 and the immutable lockfile. A public cold
install must succeed before either build. Build logs, exit codes, production
configuration, source/asset hashes and generated-file changes are retained.

Both builds use one checkout at
`c3aed73f4c5f1e7c88c31331b0b0b72c6e8f2f4a`. The candidate applies the exact
two-file patch from PR commit `d5ab02625b402364d09e556bcfb6c3bfe081831a`;
its file hashes are checked. Git HEAD remains at the base in both builds so
embedded revision metadata does not introduce an unrelated difference. This
candidate is described as **base plus the pinned patch**, not as a checkout
whose HEAD is the fix commit. Only the three known generated policy/theme files
are restored to their original bytes between builds.

Browser preparation copies each complete build and adds the identical static
internal setup page. Every compiled file and manifest byte must remain equal to
that variant's pristine build. The test also opens the real wallet UI and checks
the watch-only dashboard before closing UI windows and beginning measurement.

## Protocol declared before execution

- Three independent baseline/candidate pairs on headed Linux/Xvfb/Openbox, with
  six fresh profiles. Every pair must pass; failed attempts are retained.
- Native minimized state must be confirmed for both variants.
- Initial regular/PWA page setup has a five-second budget to reach DOM complete,
  provider ready/initialized, no cached requests and an empty pending queue. The
  wait observes state and sends no extra wallet requests. Its trace is retained.
- The first request after the forced worker restart receives no extra warm-up
  request or pre-measurement drain wait. Immediate
  response/deadline snapshots are preserved. There is no post-response drain
  wait or replacement of a nonempty snapshot with a later empty one.
- The existing strict browser verifier remains byte-identical, SHA-256
  `3743f77a252562c73121ba3d1272d5bf7b402ed83c9c10ce2b830f3e9a952397`.
  It still requires matching responses before five seconds, zero pending work
  at every successful observation, passing visible controls, unchanged document
  identity and verified worker/window/cleanup evidence.

The earlier failed records remain failed. Initial setup synchronization addresses
their initial-page concurrency confound; Linux native-window checks address the
unequal minimize confirmation. A reconnect-side `tabCheckin` still pending at
the first measured reply will fail the unchanged queue check. It will not be excused
or hidden to obtain a passing result.

Chrome may restart the worker through its own lifecycle events during the wait;
recorded target events identify when that happened. The harness does not send a
probe to wake it.

The protocol tests controlled worker-restart recovery. It does not establish the
original natural Linux resume trigger, production performance, or signing and
broadcast behavior.

## Result: all three pairs passed

[Run 39588703790](https://github.com/trungkien1992/rabby-pwa-reliability/actions/runs/39588703790)
completed on 2026-10-21 using harness commit
`a88382ee46e8b734f79f7fe0db88eece8e001e40`. All six browser processes used
fresh Linux x64 profiles, Chrome for Testing 151.0.7922.34 and an Openbox desktop
under Xvfb. Native minimization was confirmed in every run.

| Independent restart pair | Baseline: three reads after restart | Candidate: three reads after restart | Candidate immediate pending counts |
|---|---|---|---|
| 1 | Three 5-second deadlines; pending 1 / 2 / 3 | `0x1` in 2.2 / 4.2 / 0.8 ms | 0 / 0 / 0 |
| 2 | Three 5-second deadlines; pending 1 / 2 / 3 | `0x1` in 8.2 / 6.0 / 3.4 ms | 0 / 0 / 0 |
| 3 | Three 5-second deadlines; pending 1 / 2 / 3 | `0x1` in 1.4 / 0.9 / 0.7 ms | 0 / 0 / 0 |

There were **three independent forced restarts per variant**, with three
successive reads after each restart: nine measured reads per variant. All visible
regular-tab controls passed. PWA document identity stayed unchanged without a
reload; candidate final queues were also empty. The frozen strict verifier passed
each pair, and the aggregate build/runtime verifier passed again on the downloaded
artifacts. Every attempted pair is published.

All six real wallet dashboards rendered the watch-only address
`0x0000000000000000000000000000000000000001` with visible panels and no captured
uncaught exception or console error. Their DOM and screenshots are retained. UI
target destruction was confirmed before measurement. This establishes rendering
and setup compatibility, not completion of interactive wallet flows; screenshots
can include the startup release-note modal and loading balances.

Both original production builds passed, as did `yarn check` and the two focused
suites (10 tests). The immutable cold install fetched 2,418 packages on a fresh
hosted runner; the workflow configured no organization/npm token or dependency
cache restore. Actual versions
were Node 24.21.0 and Yarn 4.14.1 on a four-CPU, 15.6 GiB hosted runner. Baseline
and candidate builds took 406.6 and 391.2 seconds; these are build durations, not
wallet performance measurements. Both logs retain the same four webpack warnings:
two dynamic-dependency warnings in `ox/tempo/internal/virtualMasterPool`, the asset
size limit, and the entrypoint size limit. Dependency-install warnings are also
retained.

Each complete build contains **1,153 compiled files**. All five entry points,
six HTML pages, production minification, copied assets and Warden safeguards were
retained. The two production manifests, generated policies and themes match.
Only `background.js` differs: its sole changed byte range is deletion of the
20-byte string `,windowType:"normal"`. All other 1,152 compiled files are identical.
The generated policy SHA-256 is
`830ad612702e06559b7a6cd6305431de5fdeac9715bc332a57cd11a865f866e9`.

The tested extensions each contain those 1,153 unchanged compiled files plus the
same static `reliability-probe.html` setup page. Their 1,154-file inventories match
the actual extension directories before launch and after browser exit in all six
runs. Reading every ZIP member also confirms exact agreement with those inventories.
The setup page is disclosed; these are evidence builds, not official Rabby releases.

In all six runs, Chrome created the replacement worker **before PWA reattachment**.
The measured request is the first read after the restart, not a measurement of
cold-worker startup. The fixture uses an unapproved dapp's read-only `eth_chainId`
transport and a watch-only wallet. It does not test arbitrary RPC methods, account
approval, signing, transaction broadcast or funds. The original natural Linux
minimize/resume trigger remains unconfirmed.

## Published evidence

- [Aggregate acceptance](../results/full-source-39588703790/acceptance.json),
  [build provenance](../results/full-source-39588703790/build/build-pair.json), and
  [byte-for-byte publication manifest](../results/full-source-39588703790/provenance.json).
- Strict comparisons for [pair 1](../results/full-source-39588703790/runtime/pair-1-comparison.json),
  [pair 2](../results/full-source-39588703790/runtime/pair-2-comparison.json), and
  [pair 3](../results/full-source-39588703790/runtime/pair-3-comparison.json).
- [All six raw browser records, screenshots, captured DOM and lifecycle logs](../results/full-source-39588703790/runtime/).
- [Both production build logs, source/configuration pins, inventories and check logs](../results/full-source-39588703790/build/).
- [Download the exact tested builds and checksums](https://github.com/trungkien1992/rabby-pwa-reliability/releases/tag/full-source-evidence-39588703790).

The 100 non-ZIP files from the CI artifact are copied without redaction or outcome
filtering. The two build ZIPs are release assets so access does not depend on the
14-day Actions artifact retention. Their SHA-256 values are:

```text
28b7223c2b254ea920007985f37a905495c2cd79d7ac5ddd4694d8b612dc1f7f  baseline-tested-extension.zip
2b4d35dee968a3e304c69fd5d81e91e45f98894d8946bd6a53a4a2441e31daf8  candidate-tested-extension.zip
```

The earlier [background-only failed comparison](source-runtime-observations.md)
remains failed. This new, complete source-built comparison resolves the packaging
gap under the declared protocol; it does not change the old outcomes. Ancillary
[macOS harness preflights](../results/full-source-harness-preflights/provenance.json)
retain the asynchronous UI-closure failure and its correction. They are not counted
as full-source Linux results. The separate
[edited-release regression run](https://github.com/trungkien1992/rabby-pwa-reliability/actions/runs/39588704114)
also passed the unchanged strict comparison with the setup synchronization.

To verify the published records without rebuilding, clone this evidence repository
at the publication commit, then run:

```sh
gh release download full-source-evidence-39588703790 \
  --repo trungkien1992/rabby-pwa-reliability --pattern '*-tested-extension.zip' \
  --dir results/full-source-39588703790/build
(cd results/full-source-39588703790/build && sha256sum --check full-source-builds-SHA256SUMS.txt)
python3 scripts/verify-full-source.py results/full-source-39588703790
```

## Rerun

The manual GitHub workflow provisions the headed Linux desktop and pinned Chrome
automatically. For a local Linux run, first provide Node 24 and Chrome for Testing
151.0.7922.34, then create a fresh source checkout and output directory:

```sh
mkdir -p artifacts
git clone https://github.com/RabbyHub/Rabby.git artifacts/rabby-source
git -C artifacts/rabby-source checkout --detach c3aed73f4c5f1e7c88c31331b0b0b72c6e8f2f4a
python3 scripts/run-full-source-pair.py \
  --source "$PWD/artifacts/rabby-source" \
  --output "$PWD/artifacts/full-source/build"
```

This runs the immutable install, both complete production builds, candidate lint
and type checks, and the focused regression suite. It keeps the original
production compiler configuration. It produces tested extension roots at
`artifacts/full-source-baseline-extension` and
`artifacts/full-source-candidate-extension`, with their inventories and ZIPs in
the build output.

With a headed Linux desktop available, set `BROWSER` to the pinned Chrome
executable and run the three pairs:

```sh
mkdir -p artifacts/full-source/runtime
for pair in 1 2 3; do
  for variant in baseline candidate; do
    node scripts/probe.mjs --browser "$BROWSER" \
      --extension "$PWD/artifacts/full-source-${variant}-extension" \
      --expected-assets "$PWD/artifacts/full-source/build/${variant}/tested-dist.json" \
      --output "$PWD/artifacts/full-source/runtime/pair-${pair}-${variant}.json" \
      --mode worker-stop --wait-ms 10000 --request-timeout-ms 5000 \
      --no-sandbox true --ui-smoke true
    echo "$?" > "artifacts/full-source/runtime/pair-${pair}-${variant}.exitcode"
  done
  node scripts/verify-results.mjs \
    "artifacts/full-source/runtime/pair-${pair}-baseline.json" \
    "artifacts/full-source/runtime/pair-${pair}-candidate.json" \
    > "artifacts/full-source/runtime/pair-${pair}-comparison.json"
  echo "$?" > "artifacts/full-source/runtime/pair-${pair}-comparison.exitcode"
done
python3 scripts/verify-full-source.py artifacts/full-source \
  > artifacts/full-source/acceptance.json
```

The final `verify-full-source.py` gate requires all three passes, six fresh profiles, real UI
rendering and exact before/after runtime-file identity against each source-built
inventory. A baseline process completing is expected to record the failure;
inspect the observations and strict comparison rather than treating exit code
zero as recovery.
