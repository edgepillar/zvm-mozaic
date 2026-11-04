// Original test bodies retained; share their unchanged declared capability fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import {A, B, R, ARTIST, alpha, beta, TOPIC, TX, hex, settle, pixels, word, addressTopic, painted, credited, cleared, chunk, fixture} from './board-fixture.mjs'

test('snapshot retains original calls, progressive pixels and current metadata', async () => {
  const f = await fixture(); await f.loaded({pixels: [{index: 0, rgb: 0x123456}, {index: 99, rgb: 0xff8000}]})
  assert.equal(f.api.board.status, 'ready'); assert.equal(f.api.board.progress, 1); assert.equal(f.api.board.syncedTo, 10)
  assert.equal(f.api.colorAt(0), 0x123456); assert.equal(f.api.colorAt(99), 0xff8000); assert.equal(f.api.colorAt(1), 0xffffff)
  assert.equal(f.api.board.painted, 2n); assert.equal(f.api.board.balance, 3n); assert.equal(f.api.board.historyFrom, 0)
  assert.ok(f.requests.every(row => row.url === alpha && row.values.signal.milliseconds === 60_000))
  const read = f.requests.find(row => row.kind === 'chunk'); assert.deepEqual(read.call.args, ['0', '10000'])
  assert.equal(read.body.params[0].to, A); assert.equal(read.body.params[1], 'latest')
})
test('the million-pixel snapshot retains ten original calls and three concurrent workers', async () => {
  const f = await fixture({width: 1000, height: 1000}), done = f.api.load(); await f.reply(f.pending('head')[0], hex(10))
  assert.deepEqual(f.pending('chunk').map(row => row.call.args[0]), ['0', '10000', '20000'])
  let completed = 0
  while (f.pending('chunk').length) {assert.ok(f.pending('chunk').length <= 3); await f.reply(f.pending('chunk')[0], chunk()); completed++}
  await done; assert.equal(completed, 10); assert.equal(f.api.W, 1000); assert.equal(f.api.H, 1000); assert.equal(f.api.board.progress, 1)
  await f.background()
})
test('current load calls and synchronous fetch reentry share one complete snapshot', async () => {
  const f = await fixture(); let nested; f.reenter(row => {if (row.kind === 'head') nested = f.api.load()})
  const done = f.api.load(); assert.equal(nested, done); for (let i = 0; i < 100; i++) assert.equal(f.api.load(), done)
  assert.equal(f.requests.length, 1); f.reenter(null); await f.snapshot(); await done; await f.background()
})
test('a delayed old head starts no snapshot calls against the newly selected RPC', async () => {
  const f = await fixture(), old = f.api.load(), first = f.requests[0]
  f.change({rpc: beta, chainId: 2, contract: B, canvas: {...f.endpoint.canvas}})
  await f.reply(first, hex(10)); await old; assert.equal(f.requests.length, 2)
  await f.snapshot(20); await f.background({head: 20}); assert.equal(f.api.board.syncedTo, 20)
  assert.ok(f.requests.filter(row => row.url === beta && row.kind === 'chunk').every(row => row.body.params[0].to === B))
})
test('old snapshot chunks cannot recolor a new canvas or replace its progress', async () => {
  const f = await fixture(), old = f.api.load(); await f.reply(f.pending('head')[0], hex(10)); const held = f.pending('chunk')[0]
  f.change({rpc: beta, chainId: 2, contract: B, canvas: {...f.endpoint.canvas}})
  await f.snapshot(20, [{index: 0, rgb: 0x112233}]); await f.background({head: 20})
  await f.reply(held, chunk([{index: 0, rgb: 0xff0000}])); await old
  assert.equal(f.api.colorAt(0), 0x112233); assert.equal(f.api.board.syncedTo, 20); assert.equal(f.api.board.progress, 1)
})
test('old snapshot failures cannot replace a newer ready board', async () => {
  const f = await fixture(), old = f.api.load(), held = f.requests[0]
  f.change({rpc: beta, chainId: 2, contract: B, canvas: {...f.endpoint.canvas}}); await f.snapshot(20); await f.background({head: 20})
  await f.reject(held); await old; assert.equal(f.api.board.status, 'ready'); assert.equal(f.api.board.error, null)
})
test('same-RPC chain changes synchronously invalidate snapshot ownership', async () => {
  const f = await fixture(), old = f.api.load(), held = f.requests[0]; f.change({chainId: 2})
  await f.reply(held, hex(10)); await old; assert.equal(f.requests.length, 2); assert.equal(f.api.board.syncedTo, 0)
  assert.equal(f.watches[0].options.flush, 'sync'); await f.snapshot(20); await f.background({head: 20})
})
test('health loss clears old decoration, history and canvas pixels without changing layer dimensions', async () => {
  const f = await fixture(); await f.loaded({pixels: [{index: 0, rgb: 0x123456}], logs: [painted(5, [{index: 0, rgb: 0x123456}])]})
  f.change({health: 'checking'}); assert.equal(f.api.board.status, 'idle'); assert.equal(f.api.board.painted, null)
  assert.equal(f.api.board.balance, null); assert.equal(f.api.board.historyFrom, null); assert.equal(f.api.paints.value.length, 0)
  assert.equal(f.api.colorAt(0), 0xffffff); assert.equal(f.api.whoPainted(0), null); assert.equal(f.api.W, 10); assert.equal(f.api.H, 10)
})
test('a failed current snapshot stays visible and a later load recovers', async () => {
  const f = await fixture(), done = f.api.load(); await f.reject(f.requests[0]); await done
  assert.equal(f.api.board.status, 'error'); assert.equal(f.api.board.error, 'Memory read failed'); await f.loaded(); assert.equal(f.api.board.error, null)
})
test('late old totals cannot overwrite the new canvas counters or balance', async () => {
  const f = await fixture(); const first = f.api.load(); await f.snapshot(); await first
  const oldPainted = f.pending('painted')[0], oldBalance = f.pending('balance')[0]
  f.change({rpc: beta, chainId: 2, contract: B, canvas: {...f.endpoint.canvas}}); await f.snapshot(20); await f.background({head: 20, painted: 7, balance: 8})
  await f.reply(oldPainted, hex(41)); await f.reply(oldBalance, hex(42))
  assert.equal(f.api.board.painted, 7n); assert.equal(f.api.board.balance, 8n)
})
test('current totals coalesce forced reads and preserve the original minute cooldown', async () => {
  const f = await fixture(); await f.loaded(); const start = f.requests.length
  f.time(159_999); await f.api.refreshTotals(); assert.equal(f.requests.length, start)
  f.time(160_000); const pending = f.api.refreshTotals()
  for (let i = 0; i < 100; i++) assert.equal(f.api.refreshTotals(true), pending)
  assert.equal(f.requests.length, start + 2); await f.reply(f.pending('painted')[0], hex(9)); await f.reply(f.pending('balance')[0], hex(10)); await pending
  assert.equal(f.api.board.painted, 9n); assert.equal(f.api.board.balance, 10n)
})
test('new context totals start immediately during the previous context cooldown', async () => {
  const f = await fixture(); await f.loaded(); f.time(100_001)
  f.change({contract: B, canvas: {...f.endpoint.canvas}}); await f.snapshot(20); assert.equal(f.pending('painted').length, 1)
  assert.equal(f.pending('balance').length, 1); await f.background({head: 20})
})
test('an old totals finally cannot release a new pending counter read', async () => {
  const f = await fixture(); const initial = f.api.load(); await f.snapshot(); await initial
  const p = f.pending('painted')[0], b = f.pending('balance')[0]; f.change({rpc: beta, contract: B, canvas: {...f.endpoint.canvas}})
  await f.snapshot(20); const current = f.api.refreshTotals(true)
  await f.reply(p, hex(1)); await f.reply(b, hex(1)); assert.equal(f.api.refreshTotals(true), current)
  await f.background({head: 20}); await current
})
test('history keeps the original deployment floor, day window and five-thousand-block spans', async () => {
  const f = await fixture(); f.endpoint.deployBlock = 100; const done = f.api.load(); await f.snapshot(12_000); await done
  const first = f.pending('logs')[0]; assert.equal(first.body.params[0].fromBlock, hex(6240)); assert.equal(first.body.params[0].toBlock, hex(11239))
  await f.reply(first, []); const second = f.pending('logs')[0]; assert.equal(second.body.params[0].fromBlock, hex(11240)); assert.equal(second.body.params[0].toBlock, hex(12000))
  await f.reply(second, []); await f.background({head: 12000}); assert.equal(f.api.board.historyFrom, 6240)
})
test('late history cannot replace a new context paint list or loading flag', async () => {
  const f = await fixture(); const done = f.api.load(); await f.snapshot(); await done; const held = f.pending('logs')[0]
  f.change({rpc: beta, contract: B, canvas: {...f.endpoint.canvas}}); await f.snapshot(20)
  assert.equal(f.api.board.historyLoading, true); await f.reply(held, [painted(5, [{index: 0, rgb: 0xff0000}])])
  assert.equal(f.api.board.historyLoading, true); assert.equal(f.api.paints.value.length, 0); await f.background({head: 20})
})
test('a rejected obsolete log range starts no recursive retries on the new RPC', async () => {
  const f = await fixture(); const done = f.api.load(); await f.snapshot(); await done; const held = f.pending('logs')[0]
  f.change({rpc: beta, contract: B, canvas: {...f.endpoint.canvas}}); const count = f.requests.length
  await f.reply(held, null, {message: 'range too large'}); assert.equal(f.requests.length, count)
  await f.snapshot(20); await f.background({head: 20})
})
test('current rejected log ranges retain recursive lower-then-upper splitting and order', async () => {
  const f = await fixture(); await f.loaded(); const done = f.api.sync(14), first = f.pending('logs')[0]
  assert.equal(first.body.params[0].fromBlock, hex(11)); assert.equal(first.body.params[0].toBlock, hex(14))
  await f.reply(first, null, {message: 'range too large'}); const lower = f.pending('logs')[0]
  assert.equal(lower.body.params[0].fromBlock, hex(11)); assert.equal(lower.body.params[0].toBlock, hex(12)); await f.reply(lower, [painted(12, [{index: 0, rgb: 0x112233}])])
  const upper = f.pending('logs')[0]; assert.equal(upper.body.params[0].fromBlock, hex(13)); assert.equal(upper.body.params[0].toBlock, hex(14))
  await f.reply(upper, [painted(14, [{index: 0, rgb: 0x445566}])]); await done
  assert.equal(f.api.colorAt(0), 0x445566); assert.equal(f.api.board.syncedTo, 14)
})
test('live sync uses the beat without an extra head request and preserves complete event order', async () => {
  const f = await fixture(); await f.loaded(); const count = f.requests.length, seen = []; f.api.onArrived(rows => seen.push(...rows.map(row => row.block)))
  const done = f.api.sync(12); assert.equal(f.requests.length, count + 1)
  await f.reply(f.pending('logs')[0], [painted(11, [{index: 0, rgb: 0x112233}]), painted(12, [{index: 0, rgb: 0x445566}])]); await done
  assert.equal(f.api.colorAt(0), 0x445566); assert.deepEqual(seen, [11, 12]); assert.equal(f.api.board.syncedTo, 12)
})
test('a new board sync proceeds while the previous canvas log read is still pending', async () => {
  const f = await fixture(); await f.loaded(); const old = f.api.sync(100), held = f.pending('logs')[0]
  f.change({rpc: beta, chainId: 2, contract: B, canvas: {...f.endpoint.canvas}}); await f.snapshot(20)
  assert.equal(f.pending('head').length, 1); await f.background({head: 21})
  await f.reply(held, [painted(100, [{index: 0, rgb: 0xff0000}])]); await old
  assert.equal(f.api.board.syncedTo, 21); assert.equal(f.api.colorAt(0), 0xffffff)
})
test('a pending sync coalesces reentry and retains the newest current beat', async () => {
  const f = await fixture(); await f.loaded(); const done = f.api.sync(12)
  for (let i = 0; i < 100; i++) assert.equal(f.api.sync(14), done)
  await f.reply(f.pending('logs')[0], []); const next = f.pending('logs')[0]
  assert.equal(next.body.params[0].fromBlock, hex(13)); assert.equal(next.body.params[0].toBlock, hex(14)); await f.reply(next, []); await done
  assert.equal(f.api.board.syncedTo, 14)
})
test('a late old head hint cannot cause new-canvas reads through the old chain height', async () => {
  const f = await fixture(); await f.loaded(); const old = f.api.sync(100), held = f.pending('logs')[0]
  f.api.sync(110); f.change({rpc: beta, chainId: 2, contract: B, canvas: {...f.endpoint.canvas}})
  await f.snapshot(20); await f.background({head: 20}); await f.reply(held, []); await old
  assert.ok(f.requests.filter(row => row.url === beta && row.kind === 'logs').every(row => parseInt(row.body.params[0].toBlock, 16) <= 20))
})
test('late router discovery refreshes attribution without restarting snapshot or board status', async () => {
  const f = await fixture(); await f.loaded({pixels: [{index: 0, rgb: 0x112233}], logs: [painted(5, [{index: 0, rgb: 0x112233}], R)]})
  const chunks = f.requests.filter(row => row.kind === 'chunk').length; assert.equal(f.api.whoPainted(0).painter, R)
  f.change({router: R}); assert.equal(f.api.board.status, 'ready'); await f.background({logs: [credited(5), painted(5, [{index: 0, rgb: 0xff0000}], R)]})
  assert.equal(f.requests.filter(row => row.kind === 'chunk').length, chunks); assert.equal(f.api.colorAt(0), 0x112233)
  assert.equal(f.api.whoPainted(0).painter, ARTIST); assert.ok(f.requests.filter(row => row.kind === 'logs').at(-1).body.params[0].address.includes(R))
})
test('a pending routerless history cannot overwrite the refreshed router attribution', async () => {
  const f = await fixture(); const done = f.api.load(); await f.snapshot(); await done; const old = f.pending('logs')[0]
  f.change({router: R}); await f.background({ignore: [old], logs: [credited(5), painted(5, [{index: 0, rgb: 0x112233}], R)]})
  await f.reply(old, [painted(5, [{index: 0, rgb: 0x112233}], R)]); assert.equal(f.api.whoPainted(0).painter, ARTIST)
})
test('history does not repaint pixels or replace a newer live painter', async () => {
  const f = await fixture(); const done = f.api.load(); await f.snapshot(); await done; const old = f.pending('logs')[0]
  await f.reply(f.pending('head')[0], hex(12)); const live = f.pending('logs').find(row => row !== old)
  await f.reply(live, [painted(12, [{index: 0, rgb: 0x112233}], ARTIST)]); await f.reply(old, [painted(5, [{index: 0, rgb: 0xff0000}], R)])
  assert.equal(f.api.colorAt(0), 0x112233); assert.equal(f.api.whoPainted(0).block, 12); assert.equal(f.api.paints.value.at(-1).block, 12)
  await f.background({head: 12})
})
test('clear events preserve the original white pixels and subsequent painter attribution', async () => {
  const f = await fixture(); await f.loaded({pixels: [{index: 0, rgb: 0x112233}]}); const done = f.api.sync(12)
  await f.reply(f.pending('logs')[0], [cleared(11), painted(12, [{index: 1, rgb: 0x445566}])]); await done
  assert.equal(f.api.colorAt(0), 0xffffff); assert.equal(f.api.colorAt(1), 0x445566); assert.equal(f.api.board.clearedAt, 11)
  assert.equal(f.api.whoPainted(0), null); assert.equal(f.api.whoPainted(1).block, 12)
})
test('a listener context change refuses later old-context notifications and cursor publication', async () => {
  const f = await fixture(); await f.loaded(); const seen = []
  let off; off = f.api.onChanged(() => {off(); f.change({rpc: beta, contract: B, canvas: {...f.endpoint.canvas}})})
  f.api.onArrived(() => seen.push('old')); const done = f.api.sync(12)
  // Remove the reentrant listener through its returned disposer before new allocation.
  // Only the first old-context flush should trigger the selection.
  await f.reply(f.pending('logs')[0], [painted(12, [{index: 0, rgb: 0x112233}])]); await done
  assert.deepEqual(seen, []); assert.equal(f.api.board.syncedTo, 0)
})
