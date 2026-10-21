# Proposed Linux lifecycle assessment

The current contribution repairs a measured worker-restart path. The paid follow-up would determine whether the reported Linux minimize/resume failure uses that same path or needs an additional repair.

Agree the Linux distribution, current Chrome version and reporter's affected version with the provider/messaging owner before starting. Limit the initial assessment to two Chrome versions, one standalone PWA fixture and its regular-tab control, using a watch-only wallet and read-only requests.

Deliverables:

- A pinned reproduction and failure-boundary diagnosis, or a bounded non-reproduction with exact configurations and observations.
- For each agreed configuration: twenty natural minimize/resume cycles, with the window minimized for five minutes per cycle, plus twenty controlled worker-restart cycles. Record each first-request latency, deadline miss, pending-request count and required reload.
- A targeted regression-test PR for any confirmed additional defect, with the normal-tab control and existing disconnect/approval behavior checked.
- Rerunnable scripts, raw results, hashes, a short integration note and an explicit list of unverified cases.

Assessment completion means delivery of the agreed matrix, raw reproduction or non-reproduction results, diagnosis and integration note. If a repair is delivered, proposed acceptance is a matching chain ID within five seconds, zero remaining pending requests and no required reload in every agreed cycle. Record each failure rather than averaging it away. Signing/broadcast behavior needs its own agreed test scope; this read-only assessment does not establish it.

The measurable value is removal of reproducible stuck-request/reload cases and a test the team can rerun before releases. If the team has relevant support or session counts, compare the affected-session/reload rate before and after rollout; the local experiment alone cannot estimate production revenue or support savings.

The provider owner should approve the matrix and deliverables. The sponsor should approve the fixed fee and schedule before the assessment starts. Public review of the small READY patch can proceed independently.
