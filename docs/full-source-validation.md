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
- The first request after the forced worker restart remains cold. Immediate
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
the first cold reply will fail the unchanged queue check. It will not be excused
or hidden to obtain a passing result.

The protocol tests controlled worker-restart recovery. It does not establish the
original natural Linux resume trigger, production performance, or signing and
broadcast behavior.

Results will be added after the complete builds and all comparisons finish.
