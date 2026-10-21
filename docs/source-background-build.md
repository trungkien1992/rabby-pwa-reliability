# Source-built background comparison

This supplements the edited-release experiment with two backgrounds compiled
from Rabby source commit `c3aed73f4c5f1e7c88c31331b0b0b72c6e8f2f4a`.
It records successful builds and their byte-level comparison. The separate
[browser observations](source-runtime-observations.md) show candidate read
recovery, with explicit conditions that prevented a strict comparison pass.

A later [complete production comparison](full-source-validation.md) builds all
extension entries with the original upstream production command and passes three
fresh Linux browser pairs. The component-build records below remain historical;
they are not presented as that full extension validation.

## Recorded build results

Both builds completed with command exit code 0 and `hasErrors: false`. They used
the same source directory and compilation configuration. Only
`src/utils/message.ts` changed between them; the candidate matches the production
file in the proposed source patch.

| Build | Background bytes | SHA-256 |
|---|---:|---|
| Baseline | 53,452,199 | `bfd3ac59fbe4b6db0b557bc13bdf929f63fdb95c978286d71e90895f9f415c58` |
| Candidate | 53,452,247 | `b1962d9ff6b515e2d243fffc0ac9cf5b9ff22e23ca0186c051d80b6c5b163aac` |

Each build emitted 304 assets. **303 assets are byte-identical**; only
`background.js` differs. Its compiled diff contains the added explanatory comment
and removal of `windowType: 'normal'`, matching the intended source edit.
Generated Warden policies are identical, and the source checkout's policy
remained unchanged in both final builds. See the [build pair record](../results/source-background/background-build-pair.json)
and [compiled diff](../results/source-background/background-compiled.diff).

The recorded local compilation times were 482.349 seconds for the baseline and
260.940 seconds for the candidate. These are build times, not wallet response
benchmarks. No performance conclusion follows from that difference.

## What is compiled

[`build-background.cjs`](../scripts/build-background.cjs) loads the upstream
production webpack configuration, retains its resolution rules and TypeScript
transforms, and restricts the entry to the actual `src/background/index.ts` with
`asyncChunks: false`.

It retains the upstream Define/Provide plugins, styled-components plugin and
Warden security plugin, including its production checks and policy overrides.
Generated policy is redirected into the isolated output directory. The script
checks that the source policy bytes remain unchanged after compilation.

UI entries, HTML/copy plugins, lint/typechecking plugins, minification and source
maps are omitted. TypeScript compilation is limited to bundled files and uses
transpilation only; the full `yarn check` result is separate. Split chunks are
disabled so the background embeds its polyfill and does not replace the shared
polyfill still used by released UI/content/offscreen code. Both variants use
these identical settings.

The final CLI waits for compilation and compiler closure, verifies source-policy
identity, flushes its logs and exits with the resulting status. A small CLI
cleanup change during this run did not alter compilation configuration or inputs;
the [cleanup record](../results/source-background/background-cli-cleanup.json)
describes the actual command histories. Both final commands exited 0.

## Rebuild the pair in one source directory

Use Node 24 and the repository's pinned Yarn 4.14.1. Run one large build/check at
a time on a small machine. All directories below must be fresh. Start from this
evidence repository:

```sh
EVIDENCE="$PWD"
mkdir -p "$EVIDENCE/artifacts"
SOURCE="$EVIDENCE/artifacts/rabby-source"
git clone https://github.com/RabbyHub/Rabby.git "$SOURCE"
git -C "$SOURCE" checkout --detach c3aed73f4c5f1e7c88c31331b0b0b72c6e8f2f4a
(cd "$SOURCE" && yarn install --immutable)

node --max-old-space-size=4096 "$EVIDENCE/scripts/build-background.cjs" \
  "$SOURCE" "$EVIDENCE/artifacts/background-baseline" \
  > "$EVIDENCE/artifacts/background-baseline.log" 2>&1

git -C "$SOURCE" apply --include=src/utils/message.ts \
  "$EVIDENCE/patches/pwa-ready.patch"

node --max-old-space-size=4096 "$EVIDENCE/scripts/build-background.cjs" \
  "$SOURCE" "$EVIDENCE/artifacts/background-candidate" \
  > "$EVIDENCE/artifacts/background-candidate.log" 2>&1
```

The include option applies the exact production-file change while leaving the
test addition out of this controlled build tree. Apply the complete patch in a
separate checkout to run the regression suite and full checks described in the
main README. Do not symlink `node_modules` from another checkout: Warden matches
module paths against the source root, and resolved outside paths change that
input. Install dependencies directly in the build checkout.

Keeping one source root, commit, dependency installation and builder for both
variants avoids accidental module-ID or configuration differences. Output folders
are outside that source tree. Repeated builds on other machines may produce
different artifact hashes; retain the actual output and verify the behavior.

## Assemble a background-only hybrid

Prepare **one baseline** release tree with the existing preparation script and
pinned ZIP. Do not use the edited-release candidate as the retained tree:

```sh
python3 scripts/prepare-release.py --zip artifacts/rabby.zip \
  --output artifacts/retained-release --variant baseline

python3 scripts/assemble-background.py \
  --release artifacts/retained-release \
  --background artifacts/background-baseline \
  --output artifacts/source-baseline

python3 scripts/assemble-background.py \
  --release artifacts/retained-release \
  --background artifacts/background-candidate \
  --output artifacts/source-candidate
```

Pass the extension root printed by `prepare-release.py` if the ZIP has a wrapper
directory. The assembly script requires new outputs, validates the MV3 manifest
and background loader, retains the manifest and released entry scripts, copies
**all** background build files, and emits an external manifest of every assembled
file's SHA-256. The retained `sw.js` still imports `webextension-polyfill.js` and
`background.js`; keep the released shared polyfill and other runtime files.

This combines a source-built background and its emitted assets with the released
UI, content scripts and offscreen page, plus the identical static setup page.
The retained ZIP is v0.94.12, whose release tag resolves to
`baf640e0afff0db2402bf275825721f22fff7c7e`; the background source pin above is
different. **This is a component/hybrid test, not a full UI rebuild or proof of
equivalence to an official release build.** Build success alone does not establish
browser recovery. Use the existing browser probe and verifier on the assembled
pair, keeping those outcomes separate from the edited-release results.

## Provenance and fixture corrections

The [provenance record](../results/source-background/provenance.json) retains
original and published hashes for these logs, manifests and diffs. Publication
only replaces the absolute local workspace prefix with `<workspace>`; asset
digests, source digests, timings and outcomes remain intact. The 53 MB background
bundles and dependency directories are not included in this compact record.

An initial symlinked-dependency build failed Warden's path matching; dependencies
were then copied into the actual build source tree and the unchanged checks
passed. An earlier helper-only build also wrote its partial policy into the
checkout; the generated output was retained locally, the original was restored
exactly, and builders were corrected to isolate policy output. These were test
fixture/build-scoping mistakes, not reported wallet defects. Large local failed
attempt and policy diffs are omitted here; the final build records include
`sourcePolicyUnchanged: true`.
