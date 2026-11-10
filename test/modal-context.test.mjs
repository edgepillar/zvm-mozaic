import test from 'node:test'
import assert from 'node:assert/strict'
import {modalFixture} from './modal-fixture.mjs'

if(process.env.MOZAIC_MODAL_ORIGINAL==='1') {
  test('original parent-driven close reports a second close back to an already-closed owner',async()=>{
    const f=await modalFixture();f.setOpen(true);f.setOpen(false);f.deliver()
    assert.deepEqual(f.emissions,['close']);assert.equal(f.props.open,false);f.unmount()
  })
  test('original queued native close retires a newer opening of the same dialog',async()=>{
    const f=await modalFixture();f.setOpen(true);f.setOpen(false);f.setOpen(true)
    assert.equal(f.dialog.open,true);f.deliver()
    assert.equal(f.dialog.open,false);assert.equal(f.props.open,false);assert.deepEqual(f.emissions,['close']);f.unmount()
  })
} else {
  test('modal parent close does not report a second close to an already-closed owner',async()=>{
    const f=await modalFixture();f.setOpen(true);f.setOpen(true)
    assert.deepEqual(f.counts(),{shows:1,closes:0,queued:0})
    f.setOpen(false);f.deliver();assert.deepEqual(f.emissions,[])
    assert.deepEqual(f.counts(),{shows:1,closes:1,queued:0});f.unmount()
  })
  test('modal ignores a queued close after the same element has reopened',async()=>{
    const f=await modalFixture();f.setOpen(true);f.setOpen(false);f.setOpen(true);f.deliver()
    assert.equal(f.dialog.open,true);assert.equal(f.props.open,true);assert.deepEqual(f.emissions,[]);f.unmount()
  })
  test('modal ignores multiple retired close notifications after repeated parent transitions',async()=>{
    const f=await modalFixture();f.setOpen(true);f.setOpen(false);f.setOpen(true);f.setOpen(false);f.setOpen(true)
    f.deliver();f.deliver();assert.deepEqual(f.emissions,[]);assert.equal(f.dialog.open,true)
    assert.deepEqual(f.counts(),{shows:3,closes:2,queued:0});f.unmount()
  })
  test('modal reports a current native close and retains parent acknowledgement',async()=>{
    const f=await modalFixture();f.setOpen(true);f.nativeClose();f.deliver()
    assert.deepEqual(f.emissions,['close']);assert.equal(f.props.open,false);assert.equal(f.dialog.open,false)
    assert.deepEqual(f.counts(),{shows:1,closes:0,queued:0});f.unmount()
  })
  test('modal current closed state is acknowledged once when older and current notifications are queued',async()=>{
    const f=await modalFixture();f.setOpen(true);f.setOpen(false);f.setOpen(true);f.nativeClose()
    f.deliver();f.deliver();assert.deepEqual(f.emissions,['close']);assert.equal(f.props.open,false);f.unmount()
  })
  test('modal ignores a queued notification after its element reference is unavailable',async()=>{
    const f=await modalFixture();f.setOpen(true);f.setOpen(false);f.setOpen(true);f.detach();f.deliver()
    assert.deepEqual(f.emissions,[]);assert.equal(f.props.open,true);f.unmount()
  })
  test('modal still reports the next current native close after ignoring an older one',async()=>{
    const f=await modalFixture();f.setOpen(true);f.setOpen(false);f.setOpen(true);f.deliver()
    f.nativeClose();f.deliver();f.setOpen(true);f.nativeClose();f.deliver()
    assert.deepEqual(f.emissions,['close','close']);assert.equal(f.props.open,false);f.unmount()
  })
  test('modal retains native close on unmount and stops its declared watcher capability',async()=>{
    const f=await modalFixture();f.setOpen(true);f.unmount();f.props.open=false;f.setOpen(true)
    assert.deepEqual(f.counts(),{shows:1,closes:1,queued:1});assert.equal(f.dialog.open,false)
  })
  test('modal opens an initially requested dialog when its element attaches', async () => {
    const f = await modalFixture({open: true})
    assert.equal(f.dialog.open, true)
    assert.deepEqual(f.counts(), {shows: 1, closes: 0, queued: 0})
    f.setOpen(true)
    assert.equal(f.counts().shows, 1)
    f.unmount()
    assert.equal(f.counts().closes, 1)
  })
  test('modal uses the current request after a delayed element attachment', async () => {
    const f = await modalFixture({open: true, attached: false})
    f.setOpen(false)
    f.attach()
    assert.equal(f.dialog.open, false)
    assert.equal(f.counts().shows, 0)
    f.detach()
    f.setOpen(true)
    assert.equal(f.counts().shows, 0)
    f.attach()
    assert.equal(f.dialog.open, true)
    assert.equal(f.counts().shows, 1)
    f.unmount()
  })
}
