import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshNode } from '../dist/mesh-core/mesh/node.js';
import { encode, decode } from '../dist/mesh-core/mesh/codec.js';
import { LoopbackHub, LoopbackTransport } from '../dist/mesh-core/mesh/transports/loopback.js';

// Exercise the production router, discovery and timers through the reference carrier.
// Only the medium suppresses HELLO; application traffic still takes the normal path.
class FilteredHub extends LoopbackHub {
  blockHello = false;
  frames = [];
  deliver(src, dst, frame) {
    const env = decode(frame);
    if (this.blockHello && env.type === 'mesh.hello') return;
    this.frames.push({ src, dst, frame: frame.slice(), env });
    super.deliver(src, dst, frame);
  }
}

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

async function setup(t, ids = ['A', 'B'], links = [['A', 'B']]) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const hub = new FilteredHub();
  const nodes = new Map();
  const carriers = new Map();
  for (const id of ids) {
    const node = new MeshNode({ id, label: id, compress: false, storeMs: 0, heartbeatMs: 1000 });
    const carrier = new LoopbackTransport(hub, id);
    node.addTransport(carrier);
    nodes.set(id, node);
    carriers.set(id, carrier);
    await node.start();
  }
  t.after(async () => { for (const node of nodes.values()) await node.stop(); });
  for (const [a, b] of links) hub.link(a, b);
  await flush();
  hub.blockHello = true;
  const advance = async ms => { t.mock.timers.tick(ms); await flush(); };
  return { hub, nodes, carriers, advance, a: nodes.get('A'), b: nodes.get('B') };
}

function frame(from, to, path = [from]) {
  return encode({ v: 1, id: crypto.randomUUID(), type: 'chat.say', from, to,
    ttl: 0, path, ts: Date.now(), body: { text: 'kept message' } });
}

test('unique direct chat preserves presence beyond three heartbeats; silence still expires it', async t => {
  const { a, b, advance } = await setup(t);
  const received = [], leaves = [];
  a.on('chat.say', ctx => received.push(ctx.body.sequence));
  a.events.on('peer:leave', peer => leaves.push(peer.id));
  assert.equal(a.knownPeers().find(peer => peer.id === 'B')?.direct, true);
  for (let sequence = 1; sequence <= 8; sequence += 1) {
    await advance(1000);
    b.send('A', 'chat.say', { sequence });
    await flush();
    assert.ok(a.knownPeers().some(peer => peer.id === 'B'), `B expired during direct chat at ${sequence}s`);
  }
  assert.deepEqual(received, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(leaves, []);
  await advance(4000);
  assert.equal(a.knownPeers().some(peer => peer.id === 'B'), false);
  assert.deepEqual(leaves, ['B']);
});

test('request replies refresh direct presence even though replies bypass application handlers', async t => {
  const { a, advance } = await setup(t);
  let replies = 0;
  a.events.on('request:reply', () => { replies += 1; });
  for (let sequence = 1; sequence <= 8; sequence += 1) {
    await advance(1000);
    const reply = a.request('B', 'mesh.ping', {}, 4000);
    await flush();
    assert.ok((await reply).fwdPath.includes('A'));
    assert.ok(a.knownPeers().some(peer => peer.id === 'B'), `B expired during replies at ${sequence}s`);
  }
  assert.equal(replies, 8);
});

test('duplicate direct frames and malformed frames do not keep a peer online', async t => {
  const { a, b, hub, carriers, advance } = await setup(t);
  let delivered = 0;
  a.on('chat.say', () => { delivered += 1; });
  b.send('A', 'chat.say', { text: 'once' });
  await flush();
  const original = hub.frames.find(entry => entry.src === 'B' && entry.dst === 'A' && entry.env.type === 'chat.say').frame;
  for (let i = 0; i < 5; i += 1) {
    await advance(1000);
    hub.deliver('B', 'A', original);
    carriers.get('A').receive(new Uint8Array([0xff]), 'B');
    await flush();
  }
  assert.equal(delivered, 1);
  assert.equal(a.knownPeers().some(peer => peer.id === 'B'), false);
});

test('fresh relayed traffic does not refresh the relayed origin', async t => {
  const { a, b, nodes, advance } = await setup(t, ['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]);
  const received = [];
  a.on('chat.say', ctx => received.push(ctx.from));
  assert.equal(a.knownPeers().find(peer => peer.id === 'C')?.direct, false);
  for (let i = 0; i < 5; i += 1) {
    await advance(1000);
    b.send('A', 'chat.say', { text: 'direct neighbour' });
    nodes.get('C').send('A', 'chat.say', { text: 'relayed origin' });
    await flush();
  }
  assert.equal(received.filter(from => from === 'C').length, 5);
  assert.equal(a.knownPeers().some(peer => peer.id === 'C'), false);
  assert.ok(a.knownPeers().some(peer => peer.id === 'B'));
});

test('stored original envelopes arriving via another neighbour cannot refresh a known direct origin', async t => {
  const { a, nodes, hub, advance } = await setup(t, ['A', 'B', 'C'], [['A', 'B'], ['A', 'C']]);
  let delivered = 0;
  a.on('chat.say', ctx => { if (ctx.from === 'B') delivered += 1; });
  assert.equal(a.knownPeers().find(peer => peer.id === 'B')?.via, 'B');
  for (let i = 0; i < 5; i += 1) {
    await advance(1000);
    // Replay can retain an original path=[B]. The actual neighbour is still C.
    hub.deliver('C', 'A', frame('B', 'A'));
    nodes.get('C').send('A', 'chat.say', { text: 'actual direct sender' });
    await flush();
  }
  assert.equal(delivered, 5);
  assert.equal(a.knownPeers().some(peer => peer.id === 'B'), false);
  assert.ok(a.knownPeers().some(peer => peer.id === 'C'));
});

test('application traffic alone does not introduce unknown peers or revive expired peers', async t => {
  const { a, b, hub, advance } = await setup(t);
  await advance(4000);
  assert.deepEqual(a.knownPeers(), []);
  hub.deliver('B', 'A', frame('unknown', 'A'));
  b.send('A', 'chat.say', { text: 'after expiry' });
  await flush();
  assert.deepEqual(a.knownPeers(), []);
});
