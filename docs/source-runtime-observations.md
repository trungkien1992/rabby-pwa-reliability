# Source background browser observations

The [source-built backgrounds](source-background-build.md) were loaded with the
retained release UI/content scripts in fresh Chrome for Testing 151.0.7922.34
profiles on macOS arm64. These are component/hybrid observations. They do not
establish a full source-built extension or reproduce the original natural Linux
resume trigger.

## Latest observations

One forced worker restart per variant, with three successive read-only requests:

| Measurement | Source baseline 15 | Source candidate 16 |
|---|---|---|
| Post-restart `eth_chainId` | Three 5-second deadlines | Three `0x1` replies in 1194.7 / 2.8 / 4.6 ms |
| Methods pending immediately after each measurement | `eth_chainId` × 1 / 2 / 3 | `tabCheckin` / none / none |
| Final PWA pending count | 3 | 0 |
| Post-restart regular control | Three `0x1` replies; no pending requests | Three `0x1` replies; no pending requests |
| Same PWA document | Yes | Yes |
| Native minimized state confirmed | Yes | No |

The candidate's first `eth_chainId` reply arrived while an internal `tabCheckin`
was still pending. The next two observations and the final snapshot contain no
pending requests. The baseline control's initial reply also coincided with three
initialization methods: `getProviderState`, `rabby:getProviderConfig`, and
`tabCheckin`. All four control reads returned the expected chain ID.

**The strict comparison did not pass.** The checked-in verifier requires zero
pending requests at every successful observation, including initialization. It
stopped at the baseline control's initial nonzero snapshot. The candidate's
transient `tabCheckin` and unequal native-minimize confirmations are additional
conditions that prevent treating this as a passing matched pair. The verifier
was not weakened to accept these records.

The method-level observations support recovery of the measured read requests
with the compiled source change. They do not support a claim of zero concurrent
internal requests at every instant or a clean pass of the full comparison.
Timings are fixture measurements, not production performance estimates.

See the [baseline](../results/source-runtime/source-worker-baseline-15.json),
[candidate](../results/source-runtime/source-worker-candidate-16.json),
[failed strict check](../results/source-runtime/source-runtime-15-16-verification.json),
and [hash provenance](../results/source-runtime/provenance.json). The strict
check's input hashes refer to the original local records; provenance maps them
to the published records with the workspace prefix replaced.

## Earlier observations retained

Source runs 13/14 also showed baseline deadlines and three successful candidate
reads. Their first candidate reply coincided with one pending request,
whose method identity was not recorded by that harness version. The original
verifier additionally assumed replacement-worker startup must precede PWA
debugger reattachment. That assumption was too narrow: the first request can
wake the worker. The current verifier bounds replacement startup between the
recorded worker destruction and the first successful candidate reply, or, for
older baseline records, the later regular-control attachment.

Those earlier raw observations and their original failed check are preserved in
the same result directory. They remain supplemental observations, not passing
comparison records. Runs 15/16 added absolute request timestamps and method-only
pending-queue snapshots to identify the remaining concurrency explicitly.
