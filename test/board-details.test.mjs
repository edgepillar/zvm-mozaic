// Execute actual shipped modules through the original declared fixture ports.
import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture, painted, credited, cleared, hex, A, B, R, ARTIST, TX, alpha, beta} from './board-fixture.mjs'
const baseline = process.env.MOZAIC_DETAILS_ORIGINAL === '1'
const transaction = api => {const who = api.whoPainted(0); return who ? api.paints.value.findLast(p => p.block === who.block && p.painter === who.painter)?.tx ?? null : null}
async function pendingHistory() {
  const f = await fixture(), done = f.api.load(); await f.snapshot(10, [{index: 0, rgb: 0x112233}]); await done
  return {f, held: f.pending('logs')[0]}
}
if (baseline) {
  test('original history changes attribution without notifying the selected-pixel subscriber', async () => {
    const {f, held} = await pendingHistory(); let seen = null
    f.api.onChanged(() => {seen = f.api.whoPainted(0)})
    await f.reply(held, [painted(9, [{index: 0, rgb: 0x112233}])]); await f.background()
    assert.equal(f.api.whoPainted(0).painter, ARTIST); assert.equal(transaction(f.api), TX); assert.equal(seen, null)
  })
  test('original live pixel subscribers run before the matching transaction is published', async () => {
    const f = await fixture(); await f.loaded(); let seen = 'not called'
    f.api.onChanged(() => {seen = transaction(f.api)})
    const done = f.api.sync(11); await f.reply(f.pending('logs')[0], [painted(11, [{index: 0, rgb: 0x445566}])]); await done
    assert.equal(seen, null); assert.equal(transaction(f.api), TX)
  })
} else {
  test('history detail subscribers see complete attribution, transaction and current loading state', async () => {
    const {f, held} = await pendingHistory(); const seen = []; let pixels = 0
    f.api.onChanged(() => {pixels++}); f.api.onAttributionChanged(() => seen.push({painter: f.api.whoPainted(0).painter,
      tx: transaction(f.api), from: f.api.board.historyFrom, loading: f.api.board.historyLoading}))
    const draws = f.draws.length; await f.reply(held, [painted(9, [{index: 0, rgb: 0x445566}])])
    assert.deepEqual(seen, [{painter: ARTIST, tx: TX, from: 0, loading: false}]); assert.equal(pixels, 0); assert.equal(f.draws.length, draws)
    assert.equal(f.api.colorAt(0), 0x112233); await f.background()
  })
  test('live pixel subscribers already see the complete matching paint transaction', async () => {
    const f = await fixture(); await f.loaded(); const order = []
    f.api.onChanged(() => order.push(['pixels', transaction(f.api)])); f.api.onArrived(rows => order.push(['arrival', rows[0].tx]))
    const done = f.api.sync(11); await f.reply(f.pending('logs')[0], [painted(11, [{index: 0, rgb: 0x445566}])]); await done
    assert.deepEqual(order, [['pixels', TX], ['arrival', TX]]); assert.equal(f.api.board.syncedTo, 11)
  })
  test('unsubscribed detail consumers receive no later history refresh', async () => {
    const f = await fixture(); await f.loaded(); let first = 0, second = 0
    const off = f.api.onAttributionChanged(() => {first++}); const off2 = f.api.onAttributionChanged(() => {second++})
    f.change({router: R}); await f.background(); assert.equal(first, 1); assert.equal(second, 1)
    off(); f.change({router: null}); await f.background(); assert.equal(first, 1); assert.equal(second, 2)
    off2(); f.change({router: R}); await f.background(); assert.equal(first, 1); assert.equal(second, 2)
  })
  test('obsolete canvas history emits no detail notification for the new context', async () => {
    const {f, held} = await pendingHistory(), seen = []; f.api.onAttributionChanged(() => seen.push(f.endpoint.rpc))
    f.change({rpc: beta, chainId: 2, contract: B, canvas: {...f.endpoint.canvas}}); await f.snapshot(20)
    await f.reply(held, [painted(9, [{index: 0, rgb: 0xff0000}])]); assert.deepEqual(seen, []); assert.equal(f.api.board.historyLoading, true)
    await f.background({head: 20}); assert.deepEqual(seen, [beta]); assert.equal(f.api.paints.value.length, 0)
  })
  test('late router attribution refreshes details without a new bitmap or snapshot', async () => {
    const f = await fixture(); await f.loaded({pixels: [{index: 0, rgb: 0x112233}], logs: [painted(9, [{index: 0, rgb: 0x112233}], R)]})
    let details = 0, pixels = 0; f.api.onAttributionChanged(() => {details++}); f.api.onChanged(() => {pixels++})
    const chunks = f.requests.filter(r => r.kind === 'chunk').length, draws = f.draws.length
    f.change({router: R}); await f.background({logs: [credited(9), painted(9, [{index: 0, rgb: 0x112233}], R)]})
    assert.equal(details, 1); assert.equal(pixels, 0); assert.equal(f.api.whoPainted(0).painter, ARTIST)
    assert.equal(transaction(f.api), TX); assert.equal(f.api.colorAt(0), 0x112233); assert.equal(f.draws.length, draws)
    assert.equal(f.requests.filter(r => r.kind === 'chunk').length, chunks)
  })
  test('obsolete router scopes cannot notify or clear the current history flag', async () => {
    const {f, held} = await pendingHistory(); let count = 0; f.api.onAttributionChanged(() => {count++})
    f.change({router: R}); await f.reply(held, [painted(9, [{index: 0, rgb: 0xff0000}], R)])
    assert.equal(count, 0); assert.equal(f.api.board.historyLoading, true)
    await f.background({logs: [credited(9), painted(9, [{index: 0, rgb: 0x112233}], R)]})
    assert.equal(count, 1); assert.equal(f.api.whoPainted(0).painter, ARTIST); assert.equal(f.api.board.historyLoading, false)
  })
  test('a detail callback changing context stops remaining old subscribers', async () => {
    const {f, held} = await pendingHistory(); let swapped = false; const later = []
    f.api.onAttributionChanged(() => {if (!swapped) {swapped = true; f.change({rpc: beta, contract: B, canvas: {...f.endpoint.canvas}})}})
    f.api.onAttributionChanged(() => later.push(f.endpoint.rpc))
    await f.reply(held, [painted(9, [{index: 0, rgb: 0x112233}])]); assert.deepEqual(later, [])
    await f.snapshot(20); await f.background({head: 20}); assert.deepEqual(later, [beta])
  })
  test('rejected history is not published as successful detail knowledge', async () => {
    const {f} = await pendingHistory(); let count = 0; f.api.onAttributionChanged(() => {count++})
    let attempts = 0
    while (f.pending('logs').length) {assert.ok(++attempts <= 6); await f.reply(f.pending('logs')[0], null, {message: 'controlled history refusal'})}
    await f.background(); assert.equal(count, 0); assert.equal(f.api.board.historyFrom, null); assert.equal(f.api.board.historyLoading, false); assert.equal(f.api.board.status, 'ready')
  })
  test('old clear and paint history preserve newer live pixels and painter details', async () => {
    const {f, held} = await pendingHistory(); await f.reply(f.pending('head')[0], hex(12))
    const live = f.pending('logs').find(row => row !== held)
    await f.reply(live, [painted(12, [{index: 0, rgb: 0x445566}])]); const draws = f.draws.length; const seen = []
    f.api.onAttributionChanged(() => seen.push({block: f.api.whoPainted(0).block, painter: f.api.whoPainted(0).painter, tx: transaction(f.api)}))
    await f.reply(held, [cleared(5), painted(6, [{index: 0, rgb: 0xff0000}], R)]); await f.background({head: 12})
    assert.deepEqual(seen, [{block: 12, painter: ARTIST, tx: TX}]); assert.equal(f.api.colorAt(0), 0x445566); assert.equal(f.draws.length, draws)
  })
  test('successful empty history still publishes its current deployment floor', async () => {
    const f = await fixture(); f.endpoint.deployBlock = 5; const done = f.api.load(); await f.snapshot(10); await done
    const seen = []; f.api.onAttributionChanged(() => seen.push([f.api.board.historyFrom, f.api.board.historyLoading, f.api.paints.value.length]))
    await f.reply(f.pending('logs')[0], []); await f.background(); assert.deepEqual(seen, [[5, false, 0]])
  })
  test('reentry from a live pixel subscriber cannot publish old arrivals or cursor', async () => {
    const f = await fixture(); await f.loaded(); let switched = false, arrivals = 0
    f.api.onChanged(() => {if (!switched && f.api.whoPainted(0)?.block === 11) {switched = true; f.change({rpc: beta, contract: B, canvas: {...f.endpoint.canvas}})}})
    f.api.onArrived(() => {arrivals++})
    const done = f.api.sync(11); await f.reply(f.pending('logs')[0], [painted(11, [{index: 0, rgb: 0x445566}])]); await done
    assert.equal(arrivals, 0); assert.equal(f.api.board.syncedTo, 0); assert.equal(f.api.paints.value.length, 0)
    await f.snapshot(20); await f.background({head: 20}); assert.equal(f.api.board.syncedTo, 20)
  })
  test('split history publishes one complete ordered attribution result', async () => {
    const f = await fixture(), done = f.api.load(); await f.snapshot(14); await done; let count = 0
    f.api.onAttributionChanged(() => {count++; assert.equal(f.api.paints.value.length, 2)})
    await f.reply(f.pending('logs')[0], null, {message: 'range too large'})
    const lower = f.pending('logs')[0]; assert.equal(lower.body.params[0].fromBlock, hex(0)); assert.equal(lower.body.params[0].toBlock, hex(7))
    await f.reply(lower, [painted(7, [{index: 0, rgb: 0x112233}], R)]); assert.equal(count, 0)
    await f.reply(f.pending('logs')[0], [painted(14, [{index: 0, rgb: 0x445566}])]); await f.background({head: 14})
    assert.equal(count, 1); assert.deepEqual(Array.from(f.api.paints.value, p => p.block), [7,14]); assert.equal(f.api.whoPainted(0).painter, ARTIST)
  })
}
