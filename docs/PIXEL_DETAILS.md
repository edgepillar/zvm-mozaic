# Current pixel details

Reading history changes attribution without repainting pixels. A dedicated
`onAttributionChanged` subscription publishes the current paint list, history
floor and finished loading state after the entire owned history read succeeds.
Obsolete RPC/canvas/router scopes cannot notify a new context. Each callback
rechecks ownership so synchronous context changes stop remaining old callbacks.
Unsubscribing removes that consumer, including the normal view-unmount path.

Live sync commits its complete paint list before bitmap listeners run, so a
subscriber sees the matching painter, block and transaction together. Original
pixel-before-arrival callback order, replay, range splitting and head/cursor
ownership are preserved. History still updates attribution only, retaining newer
live colours and painters; a split read publishes one complete history result.

The view refreshes selected-pixel and stationary-pointer information through the
new attribution channel. This channel does not notify draft bitmap subscribers,
upload an unchanged canvas or trigger a million-pixel draft recount/save. Pixel
and draft-layer changes retain their existing redraw paths. Head/interval changes
refresh the selected age even while the current live-log read is pending. Invalid
or loading state refreshes cached details, and out-of-bounds picks are cleared.

The selected card distinguishes unavailable canvas data, pending recent activity
and failed activity reads. Failed or unfinished history is not evidence that a
pixel was never painted. The original known deployment/day-window explanations
remain after a successful read. No new product test hook or runtime dependency is
added; draft/pending persistence and painting/transaction sources stay unchanged.

The original 26 board-test bodies and their declared fixture prefix are unchanged
after extracting the fixture to `test/board-fixture.mjs`. Twelve further controls
execute the actual board/codec/ops modules. Two original-source observations show
history changing attribution without a pixel-listener update, and a live pixel
callback running before its transaction is in the paint list. These memory ports
do not qualify a real browser, storage engine, wallet or network.

The complete context command retains all 125 prior controls and adds these twelve.
The production Chrome witness retains its twelve source-bound Canvas/Gallery and
native-storage cases, then adds five actual UI scenarios: delayed history with a
selected pixel and stationary pointer; delayed router attribution; selected age
while live logs are held followed by the matching transaction link; explicit
failed-history knowledge; and selected details after invalidating the node.
The fixture selects the real rendered centre pixel, uses the actual cadence/node
pickers and existing explorer link, and never replaces product modules or storage
APIs. Source SHA, real foreground visibility and served build-file digests remain
bound to each witness. Independent scenarios run before the final all-pass verdict.

These checks do not establish wider overlay/navigation/concurrency/crash behavior,
independent-tab recovery, other supported browsers/platforms, real provider/wallet
execution, real NoM/finality/economic settings or maintainer/operator/release
acceptance. The full original roadmap and production NO_GO boundary remain.
