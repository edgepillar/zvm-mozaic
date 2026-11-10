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

## Preview pixel counts

The import preview uses pixelCount rather than constructing the full pixelsOf
point list only to read its length. On a full image both use the same RGBA
readback, iteration and alpha comparison. The count-only path avoids point
records and RGB unpacking for the preview and still scans the full image.
This is a source-level allocation change, not a measured runtime speed or peak
memory claim, and it does not define a new image size or format policy.

Six memory controls compare the actual count with the full-image point-list
function, including every byte cutoff, extended numeric alpha values, a bounded
100,000-pixel reference, unchanged bytes/dimensions and readback failures. The
changed import script's 20 existing controls also run locally; all 192 previous
module/script control bodies remain. These are declared memory ports, not a
native canvas, image decoder, browser or wallet.

The production witness retains all 30 prior native bodies. One new native PNG
case encodes alpha bytes 0, 127, 128 and 255 twice, uses the actual input and
range UI at 4 by 2 pixels, and requires both the displayed count and placed draft
to contain four pixels. Native ImageData, PNG encoding/decoding and canvas
readback must execute; no product or image API is replaced. See the
[canvas pixel API](https://html.spec.whatwg.org/multipage/canvas.html#pixel-manipulation).

## Stamp placement at the board edge

Stamp placement reads only the intersection of the image and the board. Points
retain their image-relative coordinates, order, RGB values and alpha threshold.
The view checks gesture ownership after the last visible write before it ends
the stroke and consumes the stamp.

The added memory tests check the readback rectangle and a context change during
the final visible write. The Chrome scenario places a four-by-two PNG at the
right edge. It checks all eight preview pixels and the exact coordinates and
colors of the four pixels saved in IndexedDB.

## Picture dimensions

Imported stamps and guides fit within the 1000-by-1000 board before the
scaled canvas is allocated. The width control follows the picture aspect
ratio and can reach one pixel for narrow imports. The on-screen preview keeps
at least one pixel on each axis. Images already within the board keep their
requested raster dimensions and existing alpha membership.

The tall SVG witness uses a 4-by-4000 input, a 1-by-1000 picture and a
1-by-240 preview. The dimensions bound the scaled canvas and its pixel
readback. Source image decoding still uses the browser's existing path.

## SVG size lookup

When the browser provides both natural dimensions, the SVG decoder uses
them directly. A source text read for size lookup happens only when a natural
dimension is missing. MIME normalization, viewBox and default-size fallback,
cancellation, and object URL ownership use the existing paths.

Memory controls count the application text calls. Chrome also dispatches a
constructed ClipboardEvent with a controlled SVG and other items through the
actual paste handler. It checks the preview, file chooser and URL disposal.
The event carries its own test data and leaves the system clipboard untouched.

## Source and bitmap budgets

Imports accept source files up to 32 MiB. The byte check runs before SVG text
reads, object URL creation and native decoding. Raster images also have a
16-million-pixel budget, sixteen times the area of the standard board. The
application checks the dimensions reported by the decoded image before making
its bitmap copy and checks the returned bitmap before retaining it. Either
failure releases owned resources and presents a size message in the dialog.
SVGs use the file budget and the scaled canvas limit. They retain a vector
source for scaling.

PNG and APNG image dimensions can be read from a checked IHDR prefix. GIF87a
and GIF89a report their logical screen size immediately after the signature.
The raster probe reads at most 33 bytes. It checks the PNG signature, chunk
shape and checksum, and checks the GIF version and screen dimensions. Recognized
oversize dimensions are rejected before object URL creation. Inconclusive or
unavailable prefixes continue through the native decoder. The later bitmap
checks cover the reported natural dimensions and the returned bitmap.

JPEG starts with the same raster probe. If more bytes could complete the frame
scan, a second read extends the prefix up to 64 KiB in total. The scanner skips
length-delimited segments and stops before
scan data. Deferred height, incomplete segments and unknown dimensions continue
through the native path. WebP checks the first VP8, VP8L or VP8X chunk within the
33-byte probe after verifying the RIFF size envelope. VP8 and VP8L supply coded
dimensions and VP8X supplies the canvas size.

The Chrome case exercises source-byte, PNG, GIF, JPEG and WebP size errors
and subsequent valid JPEG and PNG selections. Its PNG uses one-bit rows and the GIF stores a one-pixel
frame in the oversized logical screen. Both fixtures keep their encoded size
small. Other format headers and native decoder peak memory remain separate
qualification work.

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

Current-source hosted CI checks 224 module/script controls,
35 Chrome scenarios against the production bundle, all 35 original isolated contract events, fresh
contract/ABI drift checks, TypeScript and production build. Wider format/size,
browser/platform, concurrent modal/tab/crash, real wallet/provider/NoM and
maintainer/operator/release requirements remain open. All original roadmap
acceptance requirements and the production NO_GO boundary remain.
