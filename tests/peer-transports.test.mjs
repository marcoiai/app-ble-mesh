import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshNode } from '../dist/mesh-core/mesh/node.js';
import { encode, decode } from '../dist/mesh-core/mesh/codec.js';
import { LoopbackHub, LoopbackTransport } from '../dist/mesh-core/mesh/transports/loopback.js';

// Both carriers use the production reference medium and transport. Only tracing
// and controlled link loss/latency are added; no physical radio is simulated.
class TracedTransport extends LoopbackTransport {
  sent = [];
  sendTo(peer, frame) { this.sent.push({ mode: 'unicast', peer, frame: frame.slice(), env: decode(frame) }); super.sendTo(peer, frame); }
  sendAll(frame, options) { this.sent.push({ mode: 'flood', frame: frame.slice(), env: decode(frame) }); super.sendAll(frame, options); }
  messages(type) { return this.sent.filter(entry => entry.env.type === type); }
}
async function flush() { for (let i = 0; i < 16; i += 1) await Promise.resolve(); }

async function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const hubs = { wifi: new LoopbackHub(), ble: new LoopbackHub() };
  const nodes = {}, carriers = {}, leaves = { A: [], B: [] };
  for (const id of ['A', 'B']) {
    const node = new MeshNode({ id, label: id, compress: false, heartbeatMs: 60000, storeMs: 0, ...options });
    nodes[id] = node;
    carriers[id] = {};
    for (const name of ['wifi', 'ble']) { const carrier = new TracedTransport(hubs[name], id); carriers[id][name] = carrier; node.addTransport(carrier); }
    node.events.on('peer:leave', peer => leaves[id].push(peer.id));
    await node.start();
  }
  t.after(async () => { for (const node of Object.values(nodes)) await node.stop(); });
  hubs.wifi.link('A', 'B'); await flush(); hubs.ble.link('A', 'B'); await flush();
  function prefer(name) {
    // A fresh HELLO received through this existing carrier records its recency.
    carriers.A[name].receive(encode({ v: 1, id: crypto.randomUUID(), type: 'mesh.hello', from: 'B', to: 'A', ttl: 0, path: ['B'], ts: Date.now(), body: { id: 'B', label: 'B', caps: [], neighbors: ['A'] } }), 'B');
  }
  const clear = () => { for (const endpoints of Object.values(carriers)) for (const carrier of Object.values(endpoints)) carrier.sent.length = 0; };
  clear();
  return { nodes, hubs, carriers, leaves, prefer, clear, a: nodes.A, b: nodes.B,
    async advance(ms) { t.mock.timers.tick(ms); await flush(); } };
}

for (const lost of ['preferred', 'secondary']) {
  test(`losing the ${lost} carrier preserves presence and delivers chat over the surviving carrier`, async t => {
    const { a, b, hubs, carriers, leaves, prefer, clear } = await setup(t);
    prefer(lost === 'preferred' ? 'wifi' : 'ble');
    const received = []; b.on('test.chat', ctx => received.push(ctx.body.text));
    hubs.wifi.unlink('A', 'B'); clear();
    assert.deepEqual(a.knownPeers().map(peer => peer.id), ['B']);
    assert.deepEqual(b.knownPeers().map(peer => peer.id), ['A']);
    assert.deepEqual(leaves, { A: [], B: [] });
    a.send('B', 'test.chat', { text: 'after Wi-Fi loss' }); await flush();
    assert.deepEqual(received, ['after Wi-Fi loss']);
    assert.equal(carriers.A.ble.messages('test.chat')[0].mode, 'unicast');
    assert.equal(carriers.A.wifi.messages('test.chat').length, 0);
  });
}

test('a secondary carrier expires during a BLE ping without removing the peer or interrupting the reply', async t => {
  const { a, b, hubs, carriers, leaves, prefer, advance } = await setup(t);
  prefer('ble'); hubs.ble.latencyMs = 100;
  const reply = a.ping('B', 4000); reply.catch(() => {});
  await flush();
  const transmitted = carriers.A.ble.messages('mesh.ping')[0].frame;
  hubs.wifi.unlink('A', 'B');
  assert.deepEqual(a.knownPeers().map(peer => peer.id), ['B']);
  assert.deepEqual(b.knownPeers().map(peer => peer.id), ['A']);
  await advance(100); await advance(100);
  assert.deepEqual((await reply).fwdPath, ['A']);
  assert.deepEqual(leaves, { A: [], B: [] });
  assert.deepEqual(carriers.A.ble.messages('mesh.ping')[0].frame, transmitted);
});

test('duplicate and unknown carrier-down events cannot erase an active alternate carrier', async t => {
  const { a, b, hubs, carriers, leaves, prefer } = await setup(t);
  prefer('ble'); hubs.wifi.unlink('A', 'B');
  carriers.A.wifi.notifyDown('B'); carriers.A.wifi.notifyDown('not-a-peer');
  const delivered = []; b.on('test.chat', ctx => delivered.push(ctx.body.text));
  a.send('B', 'test.chat', { text: 'still connected' }); await flush();
  assert.deepEqual(delivered, ['still connected']);
  assert.deepEqual(a.knownPeers().map(peer => peer.id), ['B']);
  assert.deepEqual(leaves, { A: [], B: [] });
});

test('the final carrier loss emits one leave and replay on a new carrier retains identical bytes', async t => {
  const { a, b, hubs, carriers, leaves, prefer, clear } = await setup(t, { storeMs: 60000 });
  prefer('ble'); const delivered = []; b.on('test.chat', ctx => delivered.push(ctx.body.text));
  a.send('B', 'test.chat', { text: 'durable original' }); await flush();
  const original = carriers.A.ble.messages('test.chat')[0].frame;
  hubs.ble.unlink('A', 'B');
  assert.deepEqual(leaves, { A: [], B: [] });
  hubs.wifi.unlink('A', 'B'); carriers.A.ble.notifyDown('B'); carriers.A.wifi.notifyDown('B');
  assert.deepEqual(leaves, { A: ['B'], B: ['A'] });
  assert.deepEqual(a.knownPeers(), []); assert.deepEqual(b.knownPeers(), []);
  clear(); hubs.wifi.link('A', 'B'); await flush();
  const replay = carriers.A.wifi.messages('test.chat')[0];
  assert.equal(replay.mode, 'unicast'); assert.deepEqual(replay.frame, original);
  assert.deepEqual(delivered, ['durable original'], 'replay deduplicates at the receiver');
  assert.deepEqual(a.knownPeers().map(peer => peer.id), ['B']);
});

test('one broadcast through both carriers is delivered once with identical envelope bytes', async t => {
  const { a, b, carriers } = await setup(t);
  const delivered = []; a.on('test.chat', ctx => delivered.push(ctx.body.text));
  b.broadcast('test.chat', { text: 'one message, two carriers' }); await flush();
  assert.deepEqual(delivered, ['one message, two carriers']);
  assert.deepEqual(carriers.B.wifi.messages('test.chat')[0].frame, carriers.B.ble.messages('test.chat')[0].frame);
});
