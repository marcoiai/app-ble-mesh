import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshNode, encode, decode } from 'app-ble-mesh/mesh-core';
import { Emitter } from '../dist/mesh-core/mesh/emitter.js';

// Controlled carriers exercise the shipped MeshNode without physical radios.
class Carrier extends Emitter {
  constructor(name) { super(); this.name = name; this.links = new Set(); this.sent = []; }
  start() {}
  stop() {}
  neighbors() { return [...this.links]; }
  sendTo(peer, frame) { this.sent.push({ kind: 'unicast', peer, frame: frame.slice(), env: decode(frame) }); }
  sendAll(frame) { this.sent.push({ kind: 'flood', frame: frame.slice(), env: decode(frame) }); }
  up(peer = 'B') { this.links.add(peer); this.emit('peerUp', { peer }); }
  down(peer = 'B') { this.links.delete(peer); this.emit('peerDown', { peer }); }
  receive(frame, from = 'B') { this.emit('frame', { frame, from }); }
  hello(peer = 'B') {
    this.receive(encode({ v: 1, id: crypto.randomUUID(), type: 'mesh.hello', from: peer,
      to: null, ttl: 0, path: [peer], ts: Date.now(),
      body: { id: peer, label: peer, caps: [], neighbors: ['A'] } }), peer);
  }
  probes() { return this.sent.filter(({ env }) => env.type === 'test.probe'); }
}

async function setup(t, options = {}) {
  const node = new MeshNode({ id: 'A', label: 'A', compress: false, storeMs: 0, heartbeatMs: 60000, ...options });
  const wifi = new Carrier('wifi-test'), ble = new Carrier('ble-test');
  const leaves = [];
  node.addTransport(wifi).addTransport(ble);
  node.events.on('peer:leave', peer => leaves.push(peer.id));
  await node.start();
  t.after(() => node.stop());
  wifi.up(); wifi.hello(); ble.up(); ble.hello();
  const reset = () => { wifi.sent.length = 0; ble.sent.length = 0; };
  reset();
  return { node, wifi, ble, leaves, reset };
}

for (const lost of ['preferred', 'secondary']) {
  test(`losing the ${lost} carrier preserves presence and direct delivery`, async t => {
    const { node, wifi, ble, leaves, reset } = await setup(t);
    if (lost === 'secondary') wifi.hello();
    ble.down(); reset();
    node.send('B', 'test.probe', { value: 1 });
    assert.equal(wifi.probes().length, 1);
    assert.equal(wifi.probes()[0].kind, 'unicast');
    assert.equal(wifi.probes()[0].peer, 'B');
    assert.equal(ble.probes().length, 0);
    assert.deepEqual(node.knownPeers().map(peer => peer.id), ['B']);
    assert.deepEqual(leaves, []);
  });
}

test('inbound traffic refreshes preference; duplicate down cannot erase another carrier', async t => {
  const { node, wifi, ble, reset, leaves } = await setup(t);
  node.send('B', 'test.probe', { n: 1 });
  assert.equal(ble.probes()[0].kind, 'unicast');
  assert.equal(wifi.probes().length, 0);
  wifi.hello(); reset(); node.send('B', 'test.probe', { n: 2 });
  assert.equal(wifi.probes()[0].kind, 'unicast');
  assert.equal(ble.probes().length, 0);
  ble.down(); ble.down(); reset(); node.send('B', 'test.probe', { n: 3 });
  assert.equal(wifi.probes()[0].kind, 'unicast');
  assert.equal(ble.probes().length, 0);
  assert.deepEqual(leaves, []);
});

test('final carrier loss removes presence once, floods identical bytes, and recovers on reconnect', async t => {
  const { node, wifi, ble, reset, leaves } = await setup(t);
  ble.down(); wifi.down(); wifi.down(); reset();
  assert.deepEqual(leaves, ['B']);
  assert.deepEqual(node.knownPeers(), []);
  node.send('B', 'test.probe', { n: 1 });
  assert.equal(wifi.probes()[0].kind, 'flood');
  assert.equal(ble.probes()[0].kind, 'flood');
  assert.deepEqual(wifi.probes()[0].frame, ble.probes()[0].frame);
  wifi.up(); wifi.hello(); reset(); node.send('B', 'test.probe', { n: 2 });
  assert.equal(wifi.probes()[0].kind, 'unicast');
  assert.equal(ble.probes().length, 0);
  assert.deepEqual(node.knownPeers().map(peer => peer.id), ['B']);
});

test('the same envelope arriving through two carriers is delivered once', async t => {
  const { node, wifi, ble } = await setup(t);
  const deliveries = [];
  node.on('test.probe', ctx => deliveries.push(ctx.envelope));
  const env = { v: 1, id: crypto.randomUUID(), type: 'test.probe', from: 'B', to: 'A',
    ttl: 0, path: ['B'], ts: Date.now(), body: { value: 'one delivery' } };
  const frame = encode(env), original = frame.slice();
  wifi.receive(frame); ble.receive(frame); wifi.receive(frame);
  assert.deepEqual(deliveries, [env]);
  assert.deepEqual(frame, original);
});

test('replay preserves bytes across carriers and gossip uses the surviving carrier', async t => {
  const { node, wifi, ble, reset } = await setup(t, { storeMs: 60000, gossipFanout: 1 });
  node.send('B', 'test.probe', { value: 'durable' });
  const original = ble.probes()[0].frame;
  ble.down(); wifi.down(); reset(); wifi.up();
  assert.deepEqual(wifi.probes()[0].frame, original);
  assert.equal(wifi.probes()[0].kind, 'unicast');
  ble.up(); ble.down(); reset(); node.broadcast('test.probe', { value: 'gossip' });
  assert.equal(wifi.probes()[0].kind, 'unicast');
  assert.equal(wifi.probes().length, 1);
  assert.equal(ble.probes().length, 0);
});
