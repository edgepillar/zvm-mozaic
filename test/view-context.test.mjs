import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './view-fixture.mjs'

const down = (f, x = 500, y = 500, pointerId = 1) => f.dispatch('pointerdown', {...f.screen(x, y), pointerId})
const move = (f, x = 502, y = 502, pointerId = 1) => f.dispatch('pointermove', {...f.screen(x, y), pointerId})
const up = (f, type = 'pointerup', pointerId = 1) => f.dispatch(type, {...f.screen(502, 502), pointerId})

if (process.env.MOZAIC_VIEW_ORIGINAL === '1') {
  test('original pointer cancellation commits an uncommitted shape', async () => {
    const f = await fixture({tool: 'rect'}); down(f); move(f); f.frame()
    assert.equal(f.writes.length, 0); up(f, 'pointercancel')
    assert.ok(f.writes.length > 0); f.unmount()
  })
  test('original unrelated pointer release commits the active shape', async () => {
    const f = await fixture({tool: 'rect'}); down(f); move(f); up(f, 'pointerup', 99)
    assert.ok(f.writes.length > 0); assert.equal(f.state().mode, null); f.unmount()
  })
  test('original held spray writes into a later ready context', async () => {
    const f = await fixture({tool: 'spray', size: 4}); down(f)
    const timer = [...f.timers.values()].find(t => t.interval); assert.ok(timer)
    f.setContext('b'); timer.fn()
    assert.ok(f.writes.some(w => w.scope === 'b')); f.unmount()
  })
  test('original pinch takeover retains the preceding spray interval', async () => {
    const f = await fixture({tool: 'spray', size: 4}); down(f); down(f, 510, 510, 2)
    assert.equal(f.state().mode, 'pinch')
    assert.ok([...f.timers.values()].some(t => t.interval)); f.unmount()
  })
  test('original unmounted view rewrites the next route from its delayed timer', async () => {
    const f = await fixture(); f.exposed.zoomIn(); f.unmount()
    f.location.href = 'http://fixture.invalid/about?keep=1'; f.drainTimeouts()
    assert.ok(f.history.writes.some(url => new URL(url).pathname === '/about' && new URL(url).searchParams.has('x')))
  })
  test('original context change retains a located paint and arrival marks', async () => {
    const f = await fixture(); f.exposed.locate({x0: 10, y0: 10, x1: 11, y1: 11})
    f.arrive({x0: 10, y0: 10, x1: 11, y1: 11}); f.setContext('b')
    assert.equal(f.state().located, true); assert.equal(f.state().glide, true); assert.equal(f.state().fresh, 1); f.unmount()
  })
} else {
  test('view commits a normal owned shape release once and retires capture', async () => {
    const f = await fixture({tool: 'rect'}); down(f); move(f); f.frame(); up(f)
    assert.ok(f.writes.length > 0); assert.equal(f.state().mode, null); assert.equal(f.state().pointers, 0)
    assert.equal(f.captures.size, 0); assert.equal(f.usedColors.length, 1); f.unmount()
  })
  test('view discards a cancelled shape without writing or selecting it', async () => {
    const f = await fixture({tool: 'rect'}); down(f); move(f); f.frame(); up(f, 'pointercancel'); up(f)
    assert.equal(f.writes.length, 0); assert.equal(f.usedColors.length, 0)
    assert.equal(f.state().preview, false); assert.equal(f.state().pointers, 0); assert.equal(f.captures.size, 0); f.unmount()
  })
  test('view ignores an unrelated release and preserves the owned shape', async () => {
    const f = await fixture({tool: 'rect'}); down(f); move(f); up(f, 'pointerup', 99)
    assert.equal(f.writes.length, 0); assert.equal(f.state().mode, 'shape'); up(f)
    assert.ok(f.writes.length > 0); f.unmount()
  })
  test('view ignores an unrelated move during an owned brush stroke', async () => {
    const f = await fixture({tool: 'brush'}); down(f); const before = f.writes.length
    move(f, 520, 520, 99); assert.equal(f.writes.length, before)
    move(f); assert.ok(f.writes.length > before); up(f); f.unmount()
  })
  test('view lost capture discards previews and fences an already queued frame', async () => {
    const f = await fixture({tool: 'rect'}); down(f); move(f)
    const old = f.raf.get(f.state().previewFrame); assert.ok(old)
    up(f, 'lostpointercapture'); old(16)
    assert.equal(f.writes.length, 0); assert.equal(f.state().preview, false); assert.equal(f.state().mode, null); f.unmount()
  })
  test('view cancellation ends applied freehand work and stops further writes', async () => {
    const f = await fixture({tool: 'brush'}); down(f); move(f); const before = f.writes.length
    assert.ok(before > 0); up(f, 'pointercancel'); move(f, 510, 510)
    assert.equal(f.writes.length, before); assert.equal(f.strokes.filter(s => s.kind === 'end').length, 1); f.unmount()
  })
  test('view retains normal eraser input', async () => {
    const f = await fixture({tool: 'brush'}); down(f); up(f); f.prefs.tool = 'eraser'; f.flush(); down(f); up(f)
    assert.ok(f.writes.some(w => w.remove)); f.unmount()
  })
  test('view retains normal bounded flood input', async () => {
    const f = await fixture({tool: 'fill', width: 16, height: 16, background: i => i === 7 * 16 + 7 ? 0xffffff : 0x111111})
    down(f, 7, 7); up(f); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].rgb, f.prefs.primary); f.unmount()
  })
  test('view retains a normal owned gradient release', async () => {
    const f = await fixture({tool: 'gradient', width: 16, height: 16}); down(f, 7, 7); move(f, 9, 9); f.frame()
    f.dispatch('pointerup', {...f.screen(9, 9)}); assert.equal(f.writes.length, 256); f.unmount()
  })
  test('view discards a cancelled gradient region', async () => {
    const f = await fixture({tool: 'gradient', width: 16, height: 16}); down(f, 7, 7); move(f, 9, 9); f.frame()
    f.dispatch('pointercancel', {...f.screen(9, 9)}); assert.equal(f.writes.length, 0); assert.equal(f.state().region, 0); f.unmount()
  })
  test('view fences held spray after a context change and A to B to A return', async () => {
    const f = await fixture({tool: 'spray', size: 4}); down(f)
    const old = [...f.timers.values()].find(t => t.interval).fn
    f.setContext('b'); old(); assert.equal(f.writes.filter(w => w.scope === 'b').length, 0)
    f.setContext('a'); down(f); const before = f.writes.length; old(); assert.equal(f.writes.length, before)
    up(f); f.unmount()
  })
  test('view pinch takeover retires spray and ignores a third pointer', async () => {
    const f = await fixture({tool: 'spray', size: 4}); down(f)
    const old = [...f.timers.values()].find(t => t.interval).fn
    down(f, 510, 510, 2); const before = f.writes.length; old()
    assert.equal(f.writes.length, before); assert.equal(f.state().mode, 'pinch'); assert.equal(f.state().pointers, 2)
    down(f, 515, 515, 3); assert.equal(f.state().pointers, 2)
    up(f); assert.equal(f.state().pointers, 0); assert.equal(f.captures.size, 0); f.unmount()
  })
  test('view blur retires a held spray and the temporary space modifier', async () => {
    const f = await fixture({tool: 'spray', size: 4}); down(f)
    const old = [...f.timers.values()].find(t => t.interval).fn; const before = f.writes.length
    f.exposed.setSpace(true); f.emitWindow('blur'); old()
    assert.equal(f.writes.length, before); assert.equal(f.state().mode, null); assert.equal(f.state().space, false); f.unmount()
  })
  test('view hidden visibility retires input without resuming on visibility alone', async () => {
    const f = await fixture({tool: 'spray', size: 4}); down(f)
    const old = [...f.timers.values()].find(t => t.interval).fn; const before = f.writes.length
    f.visibility('hidden'); f.visibility('visible'); old()
    assert.equal(f.writes.length, before); assert.equal(f.state().mode, null); f.unmount()
  })
  test('view Escape cancels an uncommitted preview', async () => {
    const f = await fixture({tool: 'rect'}); down(f); move(f); f.frame(); f.emitWindow('keydown', {key: 'Escape'}); up(f)
    assert.equal(f.writes.length, 0); assert.equal(f.state().preview, false); f.unmount()
  })
  test('view tool changes retire the old preview before new input', async () => {
    const f = await fixture({tool: 'rect'}); down(f); move(f); f.prefs.tool = 'brush'; f.flush(); up(f)
    assert.equal(f.writes.length, 0); down(f); up(f); assert.ok(f.writes.length > 0); f.unmount()
  })
  test('view context reset clears marks and glides while retaining inspection coordinates', async () => {
    const f = await fixture(); down(f); up(f); move(f, 501, 501)
    const selected = f.state().picked; assert.ok(selected)
    f.exposed.locate({x0: 10, y0: 10, x1: 11, y1: 11}); f.arrive({x0: 10, y0: 10, x1: 11, y1: 11}); f.setContext('b')
    const state = f.state(); assert.equal(state.located, false); assert.equal(state.glide, false); assert.equal(state.fresh, 0)
    assert.equal(state.picked.x, selected.x); assert.equal(state.picked.y, selected.y); assert.ok(state.hover); f.unmount()
  })
  test('view unmount cancels deferred routes, minimaps and preview frames', async () => {
    const f = await fixture({tool: 'rect'}); down(f); move(f); const old = [...f.timers.values()].map(t => t.fn)
    f.unmount(); f.location.href = 'http://fixture.invalid/about?keep=1'; old.forEach(fn => fn()); f.drainTimeouts()
    assert.equal(f.history.writes.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.raf.size, 0); assert.equal(f.captures.size, 0)
  })
  test('view superseded route callbacks cannot replace a later context', async () => {
    const f = await fixture(); f.exposed.zoomIn(); const old = f.timers.get(f.state().urlTimer).fn
    f.setContext('b'); f.location.href = 'http://fixture.invalid/?node=b'; old()
    assert.equal(f.history.writes.length, 0); f.drainTimeouts()
    assert.ok(f.history.writes.every(url => new URL(url).searchParams.get('node') === 'b')); f.unmount()
  })
  test('view deferred route writes require the same live page path', async () => {
    const f = await fixture(); const old = f.timers.get(f.state().urlTimer).fn
    f.location.href = 'http://fixture.invalid/about?keep=1'; old(); assert.equal(f.history.writes.length, 0); f.unmount()
  })
  test('view manual camera controls interrupt a located glide', async () => {
    const f = await fixture(); const locate = () => f.exposed.locate({x0: 10, y0: 10, x1: 11, y1: 11})
    locate(); down(f); assert.equal(f.state().glide, false); up(f)
    locate(); f.dispatch('wheel', {deltaY: -10}); assert.equal(f.state().glide, false)
    locate(); f.exposed.fit(); assert.equal(f.state().glide, false)
    locate(); f.exposed.zoomIn(); assert.equal(f.state().glide, false); f.unmount()
  })
  test('view retains owned panning and two-pointer pinch input', async () => {
    const f = await fixture(); const before = f.state().view; down(f); move(f, 510, 510)
    assert.notDeepEqual(f.state().view, before); up(f)
    down(f); down(f, 510, 510, 2); const pinch = f.state().view; move(f, 520, 520, 2)
    assert.notDeepEqual(f.state().view, pinch); up(f); f.unmount()
  })
  test('view context changes retire the old shift-line anchor', async () => {
    const f = await fixture({tool: 'brush'}); down(f); move(f); up(f); assert.ok(f.state().strokeEnd)
    f.setContext('b'); assert.equal(f.state().strokeEnd, null)
    f.dispatch('pointerdown', {...f.screen(510, 510), shiftKey: true}); up(f)
    assert.equal(f.writes.filter(w => w.scope === 'b').length, 1); f.unmount()
  })
  test('view current dimensions preserve cover and gallery contain bounds', async () => {
    for (const bare of [false, true]) {
      const f = await fixture({bare}); f.setContext('b', [40, 40]); const [s, x, y] = f.state().view
      if (bare) {assert.ok(s >= 15); assert.equal(x, 100); assert.equal(y, 0)}
      else {assert.ok(s >= 20); assert.ok(x <= 0 && x + 40 * s >= 800); assert.ok(y <= 0 && y + 40 * s >= 600)}
      f.unmount()
    }
  })
}
