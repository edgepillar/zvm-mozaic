import test from 'node:test'
import assert from 'node:assert/strict'
import {dialogFixture,imageFixture} from './import-fixture.mjs'

const file = name => ({name})
const svg = type => new File(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 4"><rect width="8" height="4" fill="red"/></svg>'],'drawing.svg',{type})
const png = () => new File(['controlled bytes'],'picture.png',{type:'image/png'})

if(process.env.MOZAIC_IMPORT_BATCH_ORIGINAL==='1') {
  test('original synchronous import action opens a picker during a parent file-drop update',async()=>{
    const f=await dialogFixture();f.setBatch(file('drop.svg'))
    assert.equal(f.pickerCount(),1);assert.equal(f.requests.length,1)
    f.resolve(0,'drop');await f.flush();f.unmount()
  })
} else if(process.env.MOZAIC_IMPORT_ORIGINAL==='1') {
  test('original older image success replaces the newer selection',async()=>{
    const f=await dialogFixture();f.select(file('a'));f.choose(file('b'));f.resolve(1,'b');await f.flush();f.resolve(0,'a');await f.flush()
    assert.equal(f.state().bitmap.id,'a');assert.equal(f.state().name,'a');f.unmount()
  })
  test('original older image failure erases a newer successful selection',async()=>{
    const f=await dialogFixture();f.select(file('a'));f.choose(file('b'));f.resolve(1,'b');await f.flush();f.reject(0);await f.flush()
    assert.equal(f.state().bitmap,null);assert.ok(f.state().error);f.unmount()
  })
  test('original dialog close allows a pending image to publish later',async()=>{
    const f=await dialogFixture();f.select(file('a'));f.calls.finish();f.resolve(0,'a');await f.flush()
    assert.equal(f.props.open,false);assert.equal(f.state().bitmap.id,'a');f.unmount()
  })
  test('original unmounted import view still accepts a pending image',async()=>{
    const f=await dialogFixture();f.select(file('a'));f.unmount();f.resolve(0,'a');await f.flush();assert.equal(f.state().bitmap.id,'a')
  })
  test('original new pending image leaves the preceding image stampable',async()=>{
    const f=await dialogFixture();f.select(file('a'));f.resolve(0,'a');await f.flush();f.choose(file('b'));f.calls.asStamp()
    assert.equal(f.stamp.value.canvas.id,'a');f.unmount();f.resolve(1,'b');await f.flush()
  })
  test('original MIME-normalized SVG URL has no eventual release',async()=>{
    const f=await imageFixture(),pending=f.module.decode(svg(''));await f.flush();f.ready();await pending
    f.timersRun();assert.equal(f.urls.size,1);assert.equal(f.timers.length,0)
  })
} else {
  test('import keeps the newest successful selection when an older read resolves',async()=>{
    const f=await dialogFixture();f.select(file('a'));f.choose(file('b'));f.resolve(1,'b');await f.flush();f.resolve(0,'a');await f.flush()
    assert.equal(f.state().bitmap.id,'b');assert.equal(f.state().name,'b');assert.deepEqual(f.disposed,['a']);f.unmount()
  })
  test('import ignores an older failure after current success',async()=>{
    const f=await dialogFixture();f.select(file('a'));f.choose(file('b'));f.resolve(1,'b');await f.flush();f.reject(0);await f.flush()
    assert.equal(f.state().bitmap.id,'b');assert.equal(f.state().error,'');f.unmount()
  })
  test('import close aborts pending input and disposes an uncooperative late result',async()=>{
    const f=await dialogFixture();f.select(file('a'));f.calls.finish();assert.ok(f.requests[0].signal.aborted)
    f.resolve(0,'a');await f.flush();assert.equal(f.state().bitmap,null);assert.deepEqual(f.disposed,['a']);f.unmount()
  })
  test('import unmount aborts its read and rejects a late publication',async()=>{
    const f=await dialogFixture();f.select(file('a'));f.unmount();assert.ok(f.requests[0].signal.aborted)
    f.resolve(0,'a');await f.flush();assert.equal(f.state().bitmap,null);assert.deepEqual(f.disposed,['a'])
  })
  test('import clears the preceding preview before another file can become a stamp',async()=>{
    const f=await dialogFixture();f.select(file('a'));f.resolve(0,'a');await f.flush();f.choose(file('b'));f.calls.asStamp()
    assert.equal(f.stamp.value,null);assert.deepEqual(f.disposed,['a']);f.resolve(1,'b');await f.flush();f.unmount()
  })
  test('import current decode failures remain visible without retaining a preview',async()=>{
    const f=await dialogFixture();f.select(file('a'));f.reject(0,'Readable failure');await f.flush()
    assert.equal(f.state().error,'Readable failure');assert.equal(f.state().bitmap,null);f.unmount()
  })
  test('import normal stamping retains the scaled canvas after releasing its decoded source',async()=>{
    const f=await dialogFixture();f.select(file('a'));f.resolve(0,'a',8,4);await f.flush();f.calls.asStamp()
    assert.equal(f.stamp.value.canvas.id,'a');assert.equal(f.stamp.value.w,8);assert.equal(f.props.open,false)
    assert.equal(f.state().bitmap,null);assert.deepEqual(f.disposed,['a']);f.unmount()
  })
  test('import normal guide placement uses the current coordinates and releases its source',async()=>{
    const f=await dialogFixture();f.select(file('a'));f.resolve(0,'a',8,4);await f.flush();f.calls.asGuide()
    assert.equal(f.guide.picture.canvas.id,'a');assert.equal(f.guide.x,46);assert.equal(f.guide.y,58);assert.ok(f.guide.visible)
    assert.deepEqual(f.disposed,['a']);f.unmount()
  })
  test('import a file prop received while closed does not start decoding',async()=>{
    const f=await dialogFixture();f.props.file=file('a');await f.flush();assert.equal(f.requests.length,0);f.unmount()
  })
  test('import reopening the same file creates a new owned request',async()=>{
    const f=await dialogFixture();f.select(file('a'));f.calls.finish();f.props.open=true;await f.flush()
    assert.equal(f.requests.length,2);f.resolve(0,'old');f.resolve(1,'current');await f.flush()
    assert.equal(f.state().bitmap.id,'current');assert.deepEqual(f.disposed,['old']);f.unmount()
  })
  test('image normalized SVG retains its URL only until explicit disposal',async()=>{
    const f=await imageFixture(),pending=f.module.decode(svg(''));await f.flush();f.ready();const value=await pending
    assert.equal(value.vector,true);assert.equal(f.urls.size,1);assert.equal(f.timers.length,0)
    f.module.disposeDecoded(value);f.module.disposeDecoded(value);assert.equal(f.urls.size,0);assert.equal(f.revoked.length,1)
  })
  test('image correctly typed SVG has the same explicit URL lifetime',async()=>{
    const f=await imageFixture(),pending=f.module.decode(svg('image/svg+xml'));await f.flush();f.ready();const value=await pending
    assert.equal(f.urls.size,1);f.module.disposeDecoded(value);assert.equal(f.urls.size,0);assert.equal(f.timers.length,0)
  })
  test('image raster URL is released after decoding and its bitmap on disposal',async()=>{
    const f=await imageFixture(),pending=f.module.decode(png());await f.flush();f.ready();await f.flush();const bitmap=f.bitmap();const value=await pending
    assert.equal(value.vector,false);assert.equal(f.urls.size,0);assert.equal(bitmap.closed,0)
    f.module.disposeDecoded(value);f.module.disposeDecoded(value);assert.equal(bitmap.closed,1);assert.equal(f.revoked.length,1)
  })
  test('image invalid native decoding releases its object URL immediately',async()=>{
    const f=await imageFixture(),pending=f.module.decode(png());const rejected=assert.rejects(pending,/could not read/)
    await f.flush();f.bad();await rejected;assert.equal(f.urls.size,0);assert.equal(f.timers.length,0)
  })
  test('image pre-aborted reads allocate no object URL or native image',async()=>{
    const f=await imageFixture(),c=new AbortController();c.abort()
    await assert.rejects(f.module.decode(png(),c.signal),error=>error.name==='AbortError')
    assert.equal(f.urls.size,0);assert.equal(f.images.length,0)
  })
  test('image abort during native decoding promptly releases the URL',async()=>{
    const f=await imageFixture(),c=new AbortController(),pending=f.module.decode(png(),c.signal)
    const rejected=assert.rejects(pending,error=>error.name==='AbortError');await f.flush();c.abort();await rejected
    assert.equal(f.urls.size,0);f.ready();await f.flush();assert.equal(f.bitmaps.length,0)
  })
  test('image a bitmap allocated after cancellation is closed without publication',async()=>{
    const f=await imageFixture(),c=new AbortController(),pending=f.module.decode(png(),c.signal)
    const rejected=assert.rejects(pending,error=>error.name==='AbortError');await f.flush();f.ready();await f.flush()
    assert.equal(f.bitmaps.length,1);c.abort();await rejected;const bitmap=f.bitmap();await f.flush()
    assert.equal(bitmap.closed,1);assert.equal(f.urls.size,0)
  })
  test('image abort while SVG MIME normalization is pending allocates nothing',async()=>{
    const f=await imageFixture(),c=new AbortController();let release
    const value={name:'picture.svg',type:'',text:()=>new Promise(resolve=>{release=resolve})}
    const pending=f.module.decode(value,c.signal),rejected=assert.rejects(pending,error=>error.name==='AbortError')
    c.abort();release('<svg viewBox="0 0 8 4"/>');await rejected;assert.equal(f.urls.size,0);assert.equal(f.images.length,0)
  })
  test('image invalid finite dimensions release the current source',async()=>{
    const f=await imageFixture(),pending=f.module.decode(png());const rejected=assert.rejects(pending,/no size/)
    await f.flush();f.ready(undefined,Infinity,4);await rejected;assert.equal(f.urls.size,0);assert.equal(f.bitmaps.length,0)
  })
  test('import defers its action until both parent open and file props settle',async()=>{
    const f=await dialogFixture();f.setBatch(file('drop.svg'));await f.flush()
    assert.equal(f.pickerCount(),0);assert.equal(f.requests.length,1)
    f.resolve(0,'drop');await f.flush();assert.equal(f.state().bitmap.id,'drop');f.unmount()
  })
  test('import keeps a tall image selectable and its preview drawable', async () => {
    const {module} = await imageFixture()
    const f = await dialogFixture({pictureWidthLimit: module.pictureWidthLimit, scaled: module.scaled})
    const draws = []
    const preview = {width: 0, height: 0, getContext: () => ({
      drawImage(canvas, x, y, w, h) {draws.push([canvas.width, canvas.height, x, y, w, h])},
    })}
    f.setPreview(preview)
    f.select(file('tall.svg'))
    f.resolve(0, 'tall', 4, 4000)
    await f.flush()
    const {width, picture} = f.state()
    assert.deepEqual(Array.from(f.range()), [1, 1])
    assert.deepEqual([width, picture.w, picture.h, preview.width, preview.height], [1, 1, 1000, 1, 240])
    assert.deepEqual(draws, [[1, 1000, 0, 0, 1, 240]])
    f.unmount()
  })
  test('image typed SVG skips text when the decoder provides both dimensions', async () => {
    const f = await imageFixture(), file = svg('image/svg+xml')
    let reads = 0
    const text = file.text.bind(file)
    file.text = () => { reads++; return text() }
    const pending = f.module.decode(file)
    await f.flush(); f.ready(undefined, 8, 4)
    const value = await pending
    assert.deepEqual([reads, value.width, value.height, value.vector], [0, 256, 128, true])
    assert.equal(value.source, f.images[0]); assert.equal(f.urls.size, 1)
    f.module.disposeDecoded(value)
    assert.equal(f.urls.size, 0)
  })
  test('image MIME normalization does not read the normalized SVG again', async () => {
    let inputReads = 0, normalizedReads = 0
    class ObservedBlob extends Blob {
      text() { normalizedReads++; return super.text() }
    }
    const f = await imageFixture({BlobPort: ObservedBlob}), file = svg('')
    const text = file.text.bind(file)
    file.text = () => { inputReads++; return text() }
    const pending = f.module.decode(file)
    await f.flush(); f.ready(undefined, 8, 4)
    const value = await pending
    assert.deepEqual([inputReads, normalizedReads, value.width, value.height], [1, 0, 256, 128])
    assert.equal(Array.from(f.urls.values())[0].type, 'image/svg+xml')
    f.module.disposeDecoded(value)
    assert.equal(f.urls.size, 0)
  })
  test('image SVG fallback reads viewBox and default dimensions only when needed', async () => {
    for (const [text, size, natural] of [
      ['<svg viewBox="0 0 8 4"/>', [256, 128], [8, 0]],
      ['<svg width="4" height="8" viewBox="0 0 8 4"/>', [128, 256], [0, 4]],
      ['<svg/>', [512, 512], [0, 0]],
    ]) {
      const f = await imageFixture()
      let reads = 0
      const file = {name: 'fallback.svg', type: 'image/svg+xml', async text() { reads++; return text }}
      const pending = f.module.decode(file)
      await f.flush(); f.ready(undefined, ...natural)
      const value = await pending
      assert.equal(reads, 1); assert.deepEqual([value.width, value.height], size)
      assert.equal(f.urls.size, 1)
      f.module.disposeDecoded(value)
      assert.equal(f.urls.size, 0)
    }
  })
  test('image abort during the SVG size fallback releases its source URL', async () => {
    const f = await imageFixture(), abort = new AbortController()
    let complete
    const file = {name: 'pending.svg', type: 'image/svg+xml', text: () => new Promise(resolve => { complete = resolve })}
    const pending = f.module.decode(file, abort.signal)
    const rejected = assert.rejects(pending, {name: 'AbortError'})
    await f.flush(); f.ready(undefined, 0, 0); await f.flush()
    assert.equal(typeof complete, 'function'); assert.equal(f.urls.size, 1)
    abort.abort(); await rejected
    assert.equal(f.urls.size, 0); assert.equal(f.revoked.length, 1)
    complete('<svg viewBox="0 0 8 4"/>'); await f.flush()
    assert.equal(f.urls.size, 0); assert.equal(f.revoked.length, 1)
  })
  test('image rejects oversized files before text reads and URL creation', async () => {
    for (const [type, name] of [['', 'source.svg'], ['image/png', 'source.png']]) {
      const f = await imageFixture()
      let reads = 0
      const file = {type, name, size: 32 * 1024 * 1024 + 1, async text() { reads++; return '<svg/>' }}
      await assert.rejects(f.module.decode(file), {message: 'Choose an image of 32 MiB or less.'})
      assert.deepEqual([reads, f.urls.size, f.revoked.length, f.images.length, f.bitmaps.length], [0, 0, 0, 0, 0])
    }
  })
  test('image accepts the exact source and bitmap limits', async () => {
    const f = await imageFixture()
    const pending = f.module.decode({name: 'limit.png', type: 'image/png', size: 32 * 1024 * 1024})
    await f.flush(); f.ready(undefined, 4000, 4000); await f.flush()
    const bitmap = f.bitmap(), value = await pending
    assert.equal(value.source, bitmap)
    assert.deepEqual([value.width, value.height, bitmap.width, bitmap.height], [4000, 4000, 4000, 4000])
    assert.equal(f.urls.size, 0); assert.equal(bitmap.closed, 0)
    f.module.disposeDecoded(value); f.module.disposeDecoded(value)
    assert.equal(bitmap.closed, 1)
  })
  test('image rejects oversized natural raster dimensions before copying', async () => {
    const f = await imageFixture(), pending = f.module.decode(png())
    const rejected = assert.rejects(pending, {message: 'Choose a raster image with 16 million pixels or fewer.'})
    await f.flush(); f.ready(undefined, 4001, 4000); await rejected
    assert.deepEqual([f.bitmaps.length, f.urls.size, f.revoked.length], [0, 0, 1])
  })
  test('image closes a returned bitmap above the pixel limit', async () => {
    const f = await imageFixture(), pending = f.module.decode(png())
    const rejected = assert.rejects(pending, {message: 'Choose a raster image with 16 million pixels or fewer.'})
    await f.flush(); f.ready(undefined, 8, 4); await f.flush()
    const {result} = f.bitmaps[0]
    result.width = 4001; result.height = 4000
    f.bitmap(); await rejected
    assert.deepEqual([result.closed, f.urls.size, f.revoked.length], [1, 0, 1])
  })
  test('image keeps vector sizing independent from the bitmap limit', async () => {
    const f = await imageFixture(), pending = f.module.decode(svg('image/svg+xml'))
    await f.flush(); f.ready(undefined, 4001, 4000)
    const value = await pending
    assert.deepEqual([value.vector, value.width, value.height, f.bitmaps.length], [true, 4001, 4000, 0])
    assert.equal(f.urls.size, 1)
    f.module.disposeDecoded(value)
    assert.equal(f.urls.size, 0)
  })
}
