# Image import ownership

An import belongs to the open dialog and its latest file selection. Starting a
new file retires the preceding preview immediately. A late success cannot
replace a newer image, and a late error cannot erase its preview or message.
Closing or unmounting retires pending input; a reopened dialog starts a new read.
File properties received while closed do not start background imports.

The dialog supplies an abort signal to the decoder and separately checks its
selection generation before publication. It also disposes a late decoded value
if a decoder does not cooperate with cancellation. Normal stamping and guide
placement first retain a rasterised canvas, then release the decoded source.
The placed stamp/guide remains available under the existing global intent rules.

The decoder accepts an optional AbortSignal. Call disposeDecoded when its result
is no longer needed. Cleanup is idempotent. Raster object URLs are revoked once
an independent bitmap is ready; the bitmap closes when its owner releases it.
SVG object URLs remain live while the vector can be resized, then are revoked
on disposal. MIME-normalised SVGs have the same lifetime. Failures and cancelled
reads release their URLs, and a bitmap allocated after cancellation is closed.
There is no timer-based resource lifetime. Existing format detection, vector
viewBox fallback, scaling, transparency and placement rules remain.

## Parent props and actions

Retirement remains synchronous. Starting a read or opening the file picker waits
until Vue has patched both parent props and updated the dialog. This avoids
acting on an intermediate open/file pair during a file drop. The actual board
drop case must show its decoded SVG without opening an unrelated native file
chooser. All 26 first-image witness bodies remain unchanged; one drop case adds
the paired-prop path. See [Vue watcher timing](https://vuejs.org/guide/essentials/watchers.html#callback-flush-timing).

## Evidence boundaries

The memory controls execute the actual ImportDialog SFC script with an explicit
decode/disposal port, and the actual image module with explicit native-image,
bitmap, URL, canvas, clock and Vue ports. They do not compile Vue, decode an
image in a real browser or execute a wallet, SDK, storage or node. Six original
behaviours are reproduced; 20 candidate controls cover selection, late errors,
close/unmount, normal placement, cancellation and resource disposal. The 164
previous module/script controls are retained. Eight shared-modal controls are
added; see [Native modal ownership](MODAL_CONTEXT.md).

The required production witness retains all 22 prior scenarios and adds five
image cases, including the actual parent file-drop path. Three further native
modal cases cover close/reopen ownership and current Escape, including two image
paths and the node-picker consumer. The witness uses the actual compiled Vue/DOM,
native File/Blob/DataTransfer,
PNG/SVG decoders, file-input change handlers, range keyboard and placement UI.
It opens and cancels the native file chooser; controlled tiny files are assigned
to the actual input through DataTransfer. This does not qualify OS file reading
or the clipboard. No product module or image/storage API is replaced.

Object URL requests are observed through
[CDP Network events](https://chromedevtools.github.io/devtools-protocol/tot/Network/#event-requestWillBeSent).
Native fetch checks distinguish a still-owned SVG URL from one released after
replacement or close. Rendered stamp/guide pixels must survive source disposal.
The close-before-publication case changes the actual file input and closes the
dialog in one page task through
[Puppeteer page evaluation](https://pptr.dev/api/puppeteer.page.evaluate).
Every independent scenario is attempted before the verdict, with source,
browser/platform and delivered production-file digests retained.

Current-source hosted CI is still required for 192 module/script controls,
30 native Chrome scenarios, all 35 original isolated contract events, fresh
contract/ABI drift checks, TypeScript and production build. Wider format/size,
browser/platform, concurrent modal/tab/crash, real wallet/provider/NoM and
maintainer/operator/release requirements remain open. All original roadmap
acceptance requirements and the production NO_GO boundary remain.
