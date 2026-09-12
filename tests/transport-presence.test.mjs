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
    carrier.presence = new Map();
    carrier.lastPresenceAt = peer => carrier.presence.get(peer);
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

test('complete direct presence keeps a discovered peer alive while HELLO is blocked, then silence expires', async t => {
  const { a, carriers, advance } = await setup(t);
  for (let i = 0; i < 8; i++) {
    carriers.get('A').presence.set('B', Date.now());
    await advance(1000);
    assert.ok(a.knownPeers().some(p => p.id === 'B'));
  }
  await advance(4000);
  assert.deepEqual(a.knownPeers(), []);
  carriers.get('A').presence.set('B', Date.now());
  carriers.get('A').presence.set('unknown', Date.now());
  await advance(1000);
  assert.deepEqual(a.knownPeers(), [], 'beacons cannot discover or resurrect identities');
});
for (const invalid of [NaN, Infinity, 999999999]) {
  test(`invalid timestamp ${invalid} does not preserve presence`, async t => {
    const { a, carriers, advance } = await setup(t);
    carriers.get('A').presence.set('B', invalid);
    await advance(4000);
    assert.deepEqual(a.knownPeers(), []);
  });
}
test('a relay beacon cannot preserve an origin behind it', async t => {
  const { a, carriers, advance } = await setup(t, ['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]);
  assert.equal(a.knownPeers().find(p => p.id === 'C')?.direct, false);
  for (let i = 0; i < 6; i++) {
    carriers.get('A').presence.set('B', Date.now());
    await advance(1000);
  }
  assert.deepEqual(a.knownPeers().map(p => p.id), ['B']);
});
