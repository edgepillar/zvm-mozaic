# Draft persistence context

Drafts remain six-byte pixel records under the original chain-ID/canvas-address
key. The board snapshot, event replay, pending transaction APIs, pricing and
contracts are unchanged. Each in-tab partition owns its own arrays, outstanding
read, save timer and serialized writes. A retired timer never encodes a later
canvas's layer. Rapid node/canvas return reuses unfinished in-tab data instead of
discarding unsaved edits or issuing a second read for the same partition.

Restoring a partition merges saved pixels only where a person has not edited
during the pending read. Removed and undone edits retain their local intent.
An obsolete read can finish its own partition without changing the visible
canvas or displaying a stale restore toast. Failed reads and malformed saved
records remain unread; they cannot overwrite unknown data with an empty draft.
The next ready context may retry a failed read. Failed writes keep that
partition's local data for this tab, including across context changes.

The original 1200 ms debounce remains, independently for each unfinished key.
Captured arrays are retained without copying a million pixels on every frame;
encoding uses their actual membership when the timer fires. Same-key writes are
serialized. Clean inactive partitions are released after acknowledgement;
unfinished or failed user data is kept until it succeeds or this tab closes.
This in-tab retention is not durable storage or a cross-tab conflict protocol.

IndexedDB helpers resolve only on transaction completion. A request success
followed by a transaction abort is a failure. Valid legacy localStorage data is
removed only after an IndexedDB commit and only if that exact legacy value is
still present. Malformed legacy data is left untouched. Concurrent edits by
independent tabs, storage eviction, hardware power loss and real wallet/session
execution remain separate acceptance work.

`npm run test:context` adds 25 controls executing the actual draft and IndexedDB
modules with declared memory-only Vue, canvas, clock and storage capabilities.
All 100 previous endpoint, heartbeat and board controls are retained unchanged.
Four original-source observations reproduce cross-canvas restore, save-key
contamination, premature legacy removal and request-before-commit success.
These memory controls do not execute browser storage or a wallet.

`npm run test:board-browser` retains the original four production Chrome cases
and adds held chunk/history/error replies, a same-RPC canvas-picker transition,
cross-context stored reads, an unsaved A/B/A return, actual drawing and reload,
and commit-bound legacy migration. It serves the unchanged production entry
with actual Vue/DOM, native IndexedDB and localStorage. A separate same-origin
fixture tab holds real native database transactions; product modules and browser
storage APIs are not replaced. Original stale replies are held and released,
actual canvas RGB and activity DOM are checked, and persisted draft bytes are
read back through native transactions. There is no wallet or public NoM traffic.

The source SHA, actual Chrome/Node/platform and served build-file digests remain
in the witness. Broader supported browsers/platforms, navigation/concurrency and
crash cases, cross-tab resolution, real providers/extensions/wallets, NoM/finality
and economic configurations, and maintainer/operator/release acceptance stay open.
