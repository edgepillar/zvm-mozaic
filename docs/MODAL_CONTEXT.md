# Native modal close ownership

The parent owns whether a modal is open. A native close notification is acted
on only while the parent still requests the dialog and that same element is
currently closed. A notification left over from a parent-driven close does not
close a newer opening of the same element or report another close to an already
closed owner. A current native Escape still reports closure to the parent.
The existing show/close watcher, button/backdrop actions and unmount close remain.

The [HTML dialog close algorithm](https://html.spec.whatwg.org/multipage/interactive-elements.html#close-the-dialog)
queues the close notification separately from closing the element. The eight
memory controls execute the actual Modal SFC script and check its exact template
close binding. They reuse the declared Vue/compiler-macro ports and add explicit
native-dialog state, queued-event and parent-acknowledgement capabilities. Two
original observations cover a duplicate parent close and an older notification
closing a newer opening. These ports are not Vue template compilation, native
browser event/focus timing, a wallet, storage or network execution.

All 184 previous module/script controls remain. The shared port implementation
is unchanged; the import fixture only exposes its existing declarations for
reuse. The complete current module/script requirement is 192 controls.

The production Chrome witness preserves all 27 prior case bodies and adds three
independent cases. Actual product DOM button clicks and microtask checkpoints
close/reopen the same import or node-picker element before its real queued close
event arrives. The event must be trusted, target that element, arrive after it
reopened, and leave its new opening intact. The import must still decode and
display the new SVG, release the old URL and retain the current URL until its
own close. Real Escape keyboard input must close the current image/node dialog;
an image can then be imported again and disposed normally. The node input and
current board remain unchanged. No product or platform API is replaced.

The controlled tiny File/Blob/DataTransfer/drop fixtures and product DOM clicks
do not qualify OS file reading, OS drag-and-drop or clipboard integration. Both
complete job logs must bind all 192 memory controls, 30 native Chrome cases,
35 original isolated contract events, compiler/ABI drift, TypeScript and the
production build to the exact source. Source, browser/platform and delivered
production-file digests remain part of the result.

The shared modal also has wallet/account and keyboard-help consumers. Their real
provider/focus/accessibility paths, initially-open mounts, broader event sequences,
formats/sizes, other supported browsers/platforms, concurrent tabs/crash recovery,
real NoM/finality/economics and maintainer/operator/release acceptance remain open.
All original roadmap acceptance requirements and the production NO_GO boundary
remain. Earlier source/CI evidence and failures are retained.
