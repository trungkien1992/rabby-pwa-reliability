# Rabby PWA worker-restart regression

Runnable evidence for the READY-notification gap related to [Rabby #3346](https://github.com/RabbyHub/Rabby/issues/3346).

Source contribution: [Rabby PR #4189](https://github.com/RabbyHub/Rabby/pull/4189).

Chrome reported the installed standalone PWA as an `app` window. Rabby's startup notification queries only `normal` windows, so the PWA misses READY after its background worker restarts. Removing that filter repaired the measured case; the injectable-URL filter stays in place.

## Full source-built result

The [complete production comparison passed](https://github.com/trungkien1992/rabby-pwa-reliability/actions/runs/39588703790) on Linux x64, Chrome for Testing **151.0.7922.34**, Xvfb/Openbox. Both extensions were built with upstream `build:pro`, using base `c3aed73` and that same base plus the exact two-file PR patch from `d5ab026`. No released extension files were inputs. Production minification, all five entries, UI/vendor assets and Warden safeguards were retained.

Across **three independent forced worker restarts per variant**, with six fresh profiles:

| Observation | Baseline | Candidate |
|---|---|---|
| Three successive `eth_chainId` reads per restart | All nine missed the 5-second deadline | All nine returned `0x1` |
| Immediate pending counts per restart | 1 / 2 / 3 | 0 / 0 / 0 |
| Visible regular-tab controls | Passed | Passed |
| Native minimization | Confirmed in all three runs | Confirmed in all three runs |
| PWA document | Same document, no reload | Same document, no reload |

The strict verifier is **byte-identical** to the earlier failed comparison. Initial setup now waits for the actual provider initialization state; measured replies still require an immediately empty queue, with no later drain wait. The old failed records remain published as failures.

Real wallet dashboard rendering passed in all six runs, and every tested extension file matched its source-built inventory before and after execution. Of 1,153 compiled files, only `background.js` differs, by deletion of exactly `,windowType:"normal"`. Both manifests, policies and all other compiled files are identical. Each tested package adds the same disclosed setup HTML page. Immutable dependency installation, full lint/type checking and all 10 focused tests passed; build warnings are retained in the logs.

[Results, limits and rerun instructions](docs/full-source-validation.md) · [Raw records and hashes](results/full-source-39588703790/) · [Exact tested build downloads](https://github.com/trungkien1992/rabby-pwa-reliability/releases/tag/full-source-evidence-39588703790)

**Scope:** this confirms recovery after controlled worker restarts. Chrome had already started the replacement worker before PWA reattachment, so the timings are not cold-start measurements. The original natural Linux resume trigger remains unconfirmed. Dashboard rendering does not establish signing, transaction broadcast or full UI-flow correctness.

## Earlier edited-release comparisons

One paired experiment on macOS arm64, Chrome for Testing **151.0.7922.34**, Rabby **0.94.12**:

| Observation after one controlled worker restart | Baseline | One-filter candidate |
|---|---|---|
| Three successive `eth_chainId` requests | Each exceeded the 5-second deadline | Returned `0x1` in 31.8 / 4.0 / 8.5 ms |
| Pending request count after each response/deadline | 1 / 2 / 3 | 0 / 0 / 0 |
| Regular-tab control | All three returned `0x1` | All three returned `0x1` |
| PWA document | Same document, no reload | Same document, no reload |

These are three requests within **one restart per variant**, not three independent cycles. Worker target destruction and replacement were recorded; no worker debugger was attached. The watch-only account contains no signing key. The PWA did not explicitly authorize account access; the test exercises the read-only transport.

**Scope:** native minimization was not confirmed on this Mac. This is a forced worker-restart reproduction, not proof of the original natural Linux minimize/resume trigger. The timings describe this fixture, not production performance. A deadline means the promise remained pending for the observation window, not proof that it can never settle.

The later [Linux CI run passed](https://github.com/trungkien1992/rabby-pwa-reliability/actions/runs/39540217125) on Ubuntu 24.04 x64 with Xvfb/Openbox and the same Chrome/Rabby versions. After one forced worker restart per variant, the baseline missed three five-second deadlines and the edited-release candidate returned `0x1` in 1.7 / 1.5 / 1.6 ms, with zero pending requests and no reload. Visible regular-tab controls passed; both variants confirmed native minimization. Its separate, single three-minute natural minimize/restoration observation did not reproduce the hang. [Raw Linux records and pins](results/linux-verified/run.json) retain both outcomes; the original natural trigger remains unconfirmed.

## Run the browser comparison

Requires Node 24, Python 3, and a Chrome for Testing executable. Use fresh output paths. The harness creates its own browser profiles, local HTTP server, watch-only wallet and installed PWA. It requests only `eth_chainId`, then uninstalls the PWA and closes the browser.

```sh
mkdir -p artifacts
curl -fL https://github.com/RabbyHub/Rabby/releases/download/v0.94.12/Rabby_v0.94.12.zip -o artifacts/rabby.zip
python3 scripts/prepare-release.py --zip artifacts/rabby.zip --output artifacts/baseline --variant baseline
python3 scripts/prepare-release.py --zip artifacts/rabby.zip --output artifacts/candidate --variant candidate
```

The preparation script requires ZIP SHA-256 `e1132d749d4f34d3c7a870dfcfc07ecfef1b6030a1c386c28747e8e16417aa39`. Both variants add an identical static internal page for setup through Rabby's real UI controller channel. The candidate additionally removes exactly one query filter from released `background.js`. Every other released file is byte-identical. This is a controlled bundle comparison, **not a complete source rebuild**.

Set `BROWSER` to the absolute Chrome for Testing executable path, then:

```sh
node scripts/probe.mjs --browser "$BROWSER" --extension "$PWD/artifacts/baseline" --output "$PWD/artifacts/baseline.json" --mode worker-stop --wait-ms 10000 --request-timeout-ms 5000 --no-sandbox true
node scripts/probe.mjs --browser "$BROWSER" --extension "$PWD/artifacts/candidate" --output "$PWD/artifacts/candidate.json" --mode worker-stop --wait-ms 10000 --request-timeout-ms 5000 --no-sandbox true
node scripts/verify-results.mjs artifacts/baseline.json artifacts/candidate.json
```

`--no-sandbox true` was needed to start the isolated browser in the tested macOS environment. Raw CDP uses the privileged pipe transport for PWA commands and never auto-attaches to workers. The verifier checks paired macOS/Linux worker-restart records, requiring actual minimize evidence or an explicit unconfirmed-minimize limitation. A successful process exit alone is not the experiment's pass criterion; inspect the JSON and run the verifier.

For natural lifecycle investigation, use `--mode natural --wait-ms 180000`. This mode requires a confirmed native minimize and closes the same-origin regular control before waiting. A harness error is separate from a wallet failure.

## Source patch and checks

[The patch](patches/pwa-ready.patch) targets `RabbyHub/Rabby` commit `c3aed73f4c5f1e7c88c31331b0b0b72c6e8f2f4a`. It removes the window-type restriction and adds READY-delivery tests for app/popup windows, invalid IDs, delivery errors, query errors and empty results. It adds no request retry/replay or changes to account approval, permissions or signing.

The focused tests changed from **2 failed / 8 passed** to **10 passed**. The existing PortMessage disconnect tests are included. Jest used isolated TypeScript transpilation; full source lint/type checking is separate and passed. The changed READY helper and both complete production extensions compiled successfully; [full-source validation](docs/full-source-validation.md) retains the exact commands and outcomes.

Both `yarn` and the required full `yarn check` (lint and type checking) passed on the final source edit. The repository requires that sequence before committing. From a checkout at the pinned commit, apply the patch, run those checks, then run:

```sh
yarn test __tests__/utils/sendReadyMessageToTabs.test.ts __tests__/utils/portMessage.test.ts --runInBand --watchman=false
```

The source-build scripts take absolute source/output directories. `build-ready-helper.cjs` builds the changed helper; `build-background.cjs` supports a disclosed background-only hybrid experiment. Their transpilation-only builds do not replace `yarn check` or establish equivalence to an official release build.

## Evidence and remaining work

[Comparison](results/comparison.json), [baseline](results/release-worker-11.json), [candidate](results/candidate-worker-12.json), [provenance](results/provenance.json), and file manifests are checked in. Only the absolute local workspace prefix is redacted from published records; the provenance retains original and published hashes. Raw timings, target IDs and observed outcomes remain intact.

The next useful check is the reporter's natural Linux suspend/resume case, with exact Chrome/Rabby versions and repeated cycles. [Proposed paid assessment scope](docs/assessment-scope.md) describes the deliverables and acceptance criteria.

The [Linux workflow](.github/workflows/reproduce.yml) runs a fresh worker-restart comparison and one three-minute natural minimize/resume observation on Ubuntu 24.04 with Xvfb/Openbox. Its natural outcome is recorded separately: completing that experiment without a failure is a bounded non-reproduction, not proof that the reporter's configuration is unaffected.

The [first Linux run](results/linux-first-run/run.json) failed its comparison gate because the regular-tab controls were hidden. Their requests were held by the provider's visibility gate. The corrected harness restores each control before measuring it; the original failure records are retained. The natural three-minute observation completed without reproducing the hang in that one configuration.

The [second Linux run](results/linux-second-run/run.json) restored the controls correctly and recorded the expected baseline failures and candidate replies. Its strict gate still failed because a 10-second timer woke 0.09 ms early. The harness now enforces the full monotonic wait deadline; the verifier's duration and outcome requirements are unchanged. This run is retained as a failed comparison, with its raw observations.

Both earlier [source background builds](docs/source-background-build.md) completed successfully; only the intended background code differs. Those were component/hybrid builds. The later [complete source-built comparison](docs/full-source-validation.md) builds every production entry and includes a real dashboard rendering check.

The [source-background browser observations](docs/source-runtime-observations.md) show three baseline deadline misses and three candidate replies. Their strict comparison did not pass: initialization requests overlapped some successful replies, and native-minimize confirmation differed. The raw observations and failed checks are retained separately from the passing edited-release comparison above.

The [complete production comparison](results/full-source-39588703790/acceptance.json) subsequently passed all three independent pairs with the same strict verifier. It synchronizes initial provider setup, requires confirmed minimization for both variants, and binds all runtime assets to the complete source builds. It does not retroactively pass the earlier hybrid observations.
