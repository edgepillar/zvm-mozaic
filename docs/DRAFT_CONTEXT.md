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

The 1200 ms debounce applies to changed pixels. A tab keeps at most one
write in flight per key and merges each batch with the last committed draft in
a single IndexedDB readwrite transaction. Edits to different pixels are kept.
For a pixel changed by both tabs, the later committed edit wins, including an
explicit erase. Clearing and pruning affect only pixels visible to that tab.
A send without a queued local edit removes a saved pixel only if its colour
matches the sent colour. A failed send restores its colour into an empty pixel
without replacing another tab's saved colour.
Open tabs keep their working views. A fresh load reads the merged draft.

Hiding or leaving the page submits any available edits without waiting for the
next animation frame or debounce timer. The transaction's completion is the
save boundary. An interrupted transaction can lose uncommitted edits. Failed
batches remain in memory while the tab is open and can be retried on further
edits or a context change. Rendering and background board refreshes alone
start no writes.

Valid legacy localStorage data is removed only after a successful IndexedDB
transaction and only while the exact legacy value is still present. An
intentionally cleared draft leaves an empty IndexedDB value, which takes
precedence over legacy data. Malformed saved and legacy values are preserved.

`npm run test:context` runs controls executing the actual draft and IndexedDB
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
read back through native transactions. Two same-origin app tabs also draw and
erase pixels through the canvas, close a tab with a blocked save, and reload
the draft from the last committed bytes. There is no wallet or public NoM traffic.

The source SHA, actual Chrome/Node/platform and served build-file digests remain
in the witness. Broader supported browsers/platforms, storage eviction, hardware power loss,
and real providers/extensions/wallets, NoM/finality
and economic configurations, and maintainer/operator/release acceptance stay open.
