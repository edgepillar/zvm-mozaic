# View input and navigation ownership

The board view keeps transient input separate from the chain and saved draft.
An input gesture belongs to its captured pointers and current view lifetime.
Changing the node/canvas, losing capture, cancelling a pointer, changing tools,
pressing Escape, hiding the page or losing window focus retires active input.

A normal owned pointer release still commits its shape or gradient. Cancellation
discards an uncommitted preview. Freehand pixels already drawn remain local;
the active undo group is ended under the existing draft rules. An unrelated
pointer cannot move or commit another pointer's gesture. A second finger retires
the preceding spray/preview before starting the normal two-pointer camera input;
additional pointers cannot take ownership of it.

Spray intervals and preview frames capture a gesture generation. Clearing a
timer/frame is paired with an ownership check, so an already queued callback
cannot write into another context or a later A -> B -> A gesture. The status
boundary is synchronous. No change is made to draft arrays, storage keys, undo
implementation, debounce, saved-data acknowledgement or IndexedDB ownership.

Located/fresh paint marks, a glide and the previous shift-line anchor are local
to the current canvas. A new context retires them while retaining valid selected
and stationary-hover coordinates for the existing pixel-detail refresh logic.
Manual camera input interrupts a located glide. New dimensions adopt the same
cover bounds on Canvas and contain bounds in Gallery without walking the centre.

Deferred address-bar and minimap work captures the view lifetime. Address writes
also require the same page path. Unmount clears timers, preview frames, active
capture and listeners; a retired callback cannot rewrite a later route.

## Evidence boundaries

`test/view-context.test.mjs` executes the actual SFC script and actual tool/color
modules with declared memory-only Vue/compiler-macro, canvas, clock, input and
data capabilities. Its virtual observation exports exist only in that fixture.
It is not Vue compilation, browser, wallet, SDK, storage or node execution.
The existing 137 module controls remain in `test:context`; 24 view controls add
normal-input and cancellation/context/navigation regression cases.

The browser witness preserves all 17 previous production Canvas/Gallery/storage/
detail scenarios and adds five real-input, route and dimension scenarios. It
serves the actual production bundle to installed Chrome with loopback ABI/RPC.
It uses native input and same-document navigation observations through
[Puppeteer's page CDP session](https://pptr.dev/api/puppeteer.page.createcdpsession),
[Chrome's touch input API](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchTouchEvent)
and [page navigation events](https://chromedevtools.github.io/devtools-protocol/tot/Page/#event-navigatedWithinDocument).
No product module or storage API is replaced. Every independent scenario is
attempted before the all-pass verdict, and source/build/browser pins remain.

Current-source hosted CI is required for Vue/TypeScript compilation, the real
browser witnesses, all module controls and all 35 original isolated contract
events. This does not qualify other browsers/platforms, independent tabs/crash
recovery, real wallets/providers, public NoM/finality/economic behavior or release
and operator acceptance. The original roadmap requirements remain open.
