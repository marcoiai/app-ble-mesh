// Run in Node >=22: node --experimental-strip-types src/mesh-core/mesh/levelpack-secure-roundtrip.ts
import { createSecureChannel } from './secure.ts';
import { packJsonForTransport } from '../json-transport.ts';
import { levelPack } from './levelpack.ts';

function check(condition: unknown, label: string): void {
  if (!condition) throw new Error('Level Pack secure test failed: ' + label);
}
const channel = createSecureChannel('test-only-synthetic-secret-24chars');
const other = createSecureChannel('definitely-the-wrong-test-secret');
const samples: unknown[] = [
  { room: 'lab', from: 'fixture-a', label: 'tester', text: 'offline mesh test', ts: 1781300000000 },
  { from: 'fixture-a', payload: { x: 12, y: -7, tick: 42, buttons: 3 } },
  { items: Array.from({ length: 20 }, (_, i) => ({ id: 'fixture-' + i, title: 'repeated field', tick: i })) },
];
for (const sample of samples) {
  const sealed = await channel.seal(sample);
  check(sealed.kind === 'level-pack', 'new envelopes must use Level Pack binary');
  check(JSON.stringify(sealed).includes('offline mesh test') === false, 'plaintext leak');
  check(JSON.stringify(await channel.open(sealed)) === JSON.stringify(sample), 'roundtrip');
  let wrongKeyRejected = false;
  try { await other.open(sealed); } catch { wrongKeyRejected = true; }
  check(wrongKeyRejected, 'wrong key rejection');
  if (sealed.kind === 'level-pack') {
    check(sealed.stats.lpBytes === levelPack(sample).length, 'LP stats');
    const tampered = { ...sealed, data: sealed.data.slice(0, -2) + (sealed.data.slice(-2, -1) === 'A' ? 'B' : 'A') + sealed.data.slice(-1) };
    let tamperRejected = false;
    try { await channel.open(tampered); } catch { tamperRejected = true; }
    check(tamperRejected, 'tamper rejection');
    console.log('LP stats', sealed.stats, 'zip', sealed.zip);
  }
}
const legacy = await packJsonForTransport(samples[0], { passphrase: 'test-only-synthetic-secret-24chars' });
check(JSON.stringify(await channel.open(legacy)) === JSON.stringify(samples[0]), 'legacy decrypt');
console.log('PASS: Level Pack binary + AES-GCM, wrong key, tampering, legacy decode');
