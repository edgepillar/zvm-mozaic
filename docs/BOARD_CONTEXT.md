# Board read context and production entry checks

Snapshot, history, live sync and totals belong to the selected RPC, chain ID,
canvas address, canvas metadata and generation. Every RPC uses the captured URL;
ownership is checked before requests, after replies and before publication or
further range splitting. Replacing a context releases only its own pending slots.
Old results, errors and cleanup cannot affect current pixels, history, counters,
balance, progress, cursors or later listener notifications. Unavailable state
clears board decoration and the chain image while retaining draft layer dimensions
and leaving draft/pending storage sources untouched.

The original million-pixel snapshot still uses ten calls of ten thousand slots,
three workers and progressive rendering. Its before-snapshot head and subsequent
event replay remain. History keeps its deployment/day floor, 5760-block window,
5000-block spans and lower-then-upper range splitting. Historical events update
attribution only, preserving newer live pixels and painters. Sync retains current
head hints and original event order. Totals retain the minute cooldown while
coalescing a complete current read. This does not establish chain finality or
reorg recovery beyond the original board algorithm.

Router discovery may finish after the canvas is available. It invalidates only
log readers and refreshes attribution through the current cursor; it does not
restart the bitmap snapshot or reset a person's draft.

`npm run test:context` runs the actual endpoint, heartbeat, board, codec and ops
modules with explicit memory-only capabilities. `npm run test:board-browser`
requires an existing production `dist` build and installed Chrome, selected with
`CHROME_PATH` or a standard installed executable. It uses the existing
`puppeteer-core` dependency and never downloads a browser. The hosted runner
[browser inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md#browsers-and-drivers)
and [Puppeteer launch options](https://pptr.dev/api/puppeteer.launchoptions)
describe the platform inputs; the control records the actual version and platform.

The browser serves the unmodified production bundle and actual Vue/DOM from a
loopback server with controlled ABI/RPC data. It holds original old-head and
counter replies, switches nodes through the actual picker, validates delayed
router attribution in the activity DOM, draws one real unsent pixel, enters and
leaves Gallery and checks that the draft remains. Invalid input clears current
counter/balance display. Source SHA and delivered build-file digests are recorded.
No product hooks or module replacements, wallet provider or public NoM are used.

These bounded module, isolated-contract and Chrome entry controls leave real
wallet/provider/extension behavior, wider navigation and concurrency/crash cases,
other supported browsers/platforms, real NoM/finality/economic configurations and
maintainer/operator/release acceptance open.

Draft storage context, native IndexedDB coverage and remaining persistence limits
are described in [DRAFT_CONTEXT.md](DRAFT_CONTEXT.md).

Current selected-pixel/history publication is described in [PIXEL_DETAILS.md](PIXEL_DETAILS.md).
