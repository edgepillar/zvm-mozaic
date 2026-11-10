import test from 'node:test'
import assert from 'node:assert/strict'
import {imageFixture} from './import-fixture.mjs'

// Controlled RGBA readback bytes, not a native canvas, image decoder or browser.
function picture(w,h,alphas) {
  const bytes=new Uint8ClampedArray(w*h*4)
  for(let i=0;i<w*h;i++) {
    bytes[i*4]=(i*17+3)&255;bytes[i*4+1]=(i*31+7)&255;bytes[i*4+2]=(i*43+11)&255
    bytes[i*4+3]=alphas(i)
  }
  return {name:'Controlled RGBA',w,h,bytes,canvas:{getContext(){return {getImageData(){return {data:bytes}}}}}}
}

test('image count preserves default transparent and half-opacity membership',async()=>{
  const f=await imageFixture(),p=picture(3,2,i=>[0,127,128,255,1,254][i])
  assert.equal(f.module.pixelCount(p),3)
  assert.equal(f.module.pixelCount(p),f.module.pixelsOf(p).length)
})

test('image count matches the original point list at every byte alpha cutoff',async()=>{
  const f=await imageFixture(),p=picture(32,32,i=>(i*73+19)&255)
  for(let alpha=0;alpha<256;alpha++)assert.equal(f.module.pixelCount(p,alpha),f.module.pixelsOf(p,alpha).length,'alpha '+alpha)
})

test('image count retains existing extended numeric alpha comparison semantics',async()=>{
  const f=await imageFixture(),p=picture(7,3,i=>(i*73+19)&255)
  for(const alpha of [-Infinity,-1,0,0.5,127.5,128,255,255.5,256,Infinity,NaN])
    assert.equal(f.module.pixelCount(p,alpha),f.module.pixelsOf(p,alpha).length,'alpha '+String(alpha))
})

test('image count returns the same scalar for a bounded hundred-thousand-pixel reference',async()=>{
  const f=await imageFixture(),p=picture(400,250,i=>(i*73+19)&255)
  const reference=f.module.pixelsOf(p)
  const count=f.module.pixelCount(p)
  assert.equal(typeof count,'number');assert.equal(count,reference.length)
  assert.ok(count>0 && count<p.w*p.h)
})

test('image count leaves controlled RGBA bytes and dimensions unchanged across reads',async()=>{
  const f=await imageFixture(),p=picture(1,257,i=>(i*73+19)&255),before=p.bytes.slice()
  const expected=f.module.pixelsOf(p).length
  assert.equal(f.module.pixelCount(p),expected);assert.equal(f.module.pixelCount(p),expected)
  assert.deepEqual(p.bytes,before);assert.equal(p.w,1);assert.equal(p.h,257)
})

test('image count propagates the same declared canvas readback failure as the point list',async()=>{
  const f=await imageFixture(),failure=new Error('Declared RGBA readback failure')
  const p={name:'Unavailable readback',w:4,h:2,canvas:{getContext(){return {getImageData(){throw failure}}}}}
  assert.throws(()=>f.module.pixelCount(p),error=>error===failure)
  assert.throws(()=>f.module.pixelsOf(p),error=>error===failure)
})


test('stamp points read only the board overlap and retain picture coordinates', async () => {
  const {module} = await imageFixture()
  const p = picture(4, 3, i => [0, 127, 128, 255][i % 4])
  const reads = []
  p.canvas.getContext = () => ({
    getImageData(x, y, w, h) {
      reads.push([x, y, w, h])
      const data = new Uint8ClampedArray(w * h * 4)
      for (let row = 0; row < h; row++) {
        const start = ((y + row) * p.w + x) * 4
        data.set(p.bytes.subarray(start, start + w * 4), row * w * 4)
      }
      return {data}
    },
  })
  const full = Array.from(module.pixelsOf(p), point => ({...point}))
  reads.length = 0
  for (const [bounds, read] of [
    [{x: -2, y: -1, w: 5, h: 3}, [0, 0, 3, 2]],
    [{x: 1, y: 1, w: 5, h: 4}, [1, 1, 3, 2]],
  ]) {
    const expected = full.filter(({x, y}) => x >= bounds.x && y >= bounds.y
      && x < bounds.x + bounds.w && y < bounds.y + bounds.h)
    assert.deepEqual(Array.from(module.pixelsOf(p, undefined, bounds), point => ({...point})), expected)
    assert.deepEqual(reads.splice(0), [read])
  }
  assert.equal(module.pixelsOf(p, undefined, {x: 4, y: 0, w: 1, h: 1}).length, 0)
  assert.deepEqual(reads, [])
})

test('image scaling fits both board dimensions and retains in-bounds requests', async () => {
  const {module} = await imageFixture()
  for (const [width, height, requested, expected] of [
    [4, 4000, 128, [1, 1000]],
    [9, 1999, 1000, [5, 1000]],
    [1, 4096, 1, [1, 1000]],
    [4000, 1, 2500, [1000, 1]],
    [1000, 1000, 1000, [1000, 1000]],
    [1000, 1001, 999, [999, 1000]],
    [100, 29, 50, [50, 15]],
    [4, 2, 4, [4, 2]],
  ]) {
    const picture = module.scaled({width, height, source: {}, vector: false}, requested, 'Controlled image')
    assert.deepEqual([picture.w, picture.h], expected)
    assert.deepEqual([picture.canvas.width, picture.canvas.height], expected)
  }
})
