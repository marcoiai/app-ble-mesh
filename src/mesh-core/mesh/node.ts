// ── MeshNode: the node-facing API ────────────────────────────────────────────
// Wires identity + transports + router together and exposes the verbs apps use:
//   send / broadcast            — fire-and-forget messages
//   publish / subscribe         — pub/sub topics (chat rooms, streams, lobbies)
//   request                     — request/reply over the mesh
//   on                          — low-level handler by message type
//   use                         — register a Service (chat/trade/stream/game/…)
// Plus peer discovery via periodic hello beacons.

import { encode } from './codec.ts';
import { Emitter } from './emitter.ts';
import { createIdentity, type IdentityOptions } from './identity.ts';
import { Router, type Route } from './router.ts';
import { shortestPaths } from './graph.ts';
import { ForwardStore } from './store.ts';
import { createSecureChannel, type SecureChannel } from './secure.ts';
import { packBody, packBodySmallest, unpackBody, compressionSupported, encodedSize, type BodyCodec } from './compress.ts';
import type { JsonTransportEnvelope } from '../json-transport.ts';
import type { Transport } from './transport.ts';
import {
  PROTOCOL_VERSION,
  type Envelope,
  type MessageContext,
  type MessageHandler,
  type NodeId,
  type NodeInfo,
  type PeerRecord,
} from './types.ts';

const HELLO = 'mesh.hello';
const BYE = 'mesh.bye';

export type MeshNodeEvents = {
  started: void;
  stopped: void;
  'peer:join': PeerRecord;
  'peer:update': PeerRecord;
  'peer:leave': PeerRecord;
  message: MessageContext;
};

export interface MeshNodeOptions extends IdentityOptions {
  /** Default relay budget for app messages (0 = neighbours only). */
  defaultTtl?: number;
  /**
   * Relay budget for hello beacons → how far presence travels. 0 = direct
   * neighbours only; higher values populate the mesh roster with relayed peers
   * (still distinguishable by hop count). Keep small to bound beacon flooding.
   */
  discoveryTtl?: number;
  /** Hello beacon interval (ms). */
  heartbeatMs?: number;
  /** Routing mode passed to the Router. */
  routing?: 'flood' | 'unicast';
  /** gzip app payloads on the open mesh (default: true when supported). */
  compress?: boolean;
  /** Only compress payloads at least this many bytes (default 256). */
  compressThreshold?: number;
  /**
   * Open-mesh body codec. 'auto' (default) tries gzip/lp/lpgz and picks the
   * smallest result for each message. 'gzip'/'lp'/'lpgz' forces a specific
   * codec — useful for debugging or when you need deterministic wire output.
   * Receivers always decode by the envelope's `zc` field so all options are
   * backward-compatible.
   */
  bodyCodec?: BodyCodec | 'auto';
  /**
   * Store-and-forward hold time (ms). A node keeps recent frames and replays them to
   * peers that appear later, so a message survives gaps in time ("some e volta").
   * Default 5 min; 0 disables. The receiver's dedup makes replay harmless.
   */
  storeMs?: number;
  /** Max frames held for store-and-forward (default 512). */
  storeCapacity?: number;
  /**
   * Broadcast fanout for gossip propagation. 0 (default) = classic flood: send to every
   * direct neighbour via sendAll. ≥1 = pick that many neighbours at random and unicast to
   * each. The Router's dedup LRU suppresses copies, so a small fanout (3–4) is enough to
   * cover an island while cutting application-level echoes — the win that scales the mesh
   * past a handful of nodes. Set when explicitly opting in; the default keeps current
   * behaviour everywhere. Broadcast-medium transports (BLE/UDP) still saturate the radio
   * at the same cost — gossip cuts the *upper layer* duplication, not the radio.
   */
  gossipFanout?: number;
}

export interface MeshService<API = unknown> {
  readonly name: string;
  attach(node: MeshNode): API;
  detach?(node: MeshNode): void;
}

interface PendingRequest {
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MeshNode {
  /** Lifecycle + discovery events (peer:join/update/leave, started/stopped, message). */
  readonly events = new Emitter<MeshNodeEvents>();
  readonly info: NodeInfo;
  readonly id: NodeId;
  private router: Router;
  private store: ForwardStore;
  private transports: Transport[] = [];
  private unsubs: Array<() => void> = [];
  private peerToTransport = new Map<string, Transport>();
  private handlers = new Map<string, Set<MessageHandler>>();
  private channels = new Map<string, Set<MessageHandler>>();
  private pending = new Map<string, PendingRequest>();
  private peers = new Map<NodeId, PeerRecord>();
  private services = new Map<string, unknown>();
  private serviceObjects: MeshService[] = [];

  private defaultTtl: number;
  private discoveryTtl: number;
  private heartbeatMs: number;
  private compress: boolean;
  private compressThreshold: number;
  private bodyCodec: BodyCodec | 'auto';
  private gossipFanout: number;
  private heartbeat?: ReturnType<typeof setInterval>;
  private running = false;
  private secure: SecureChannel | null = null;
  private secretKey: string | null = null;

  constructor(opts: MeshNodeOptions = {}) {
    this.info = createIdentity(opts);
    this.id = this.info.id;
    this.defaultTtl = opts.defaultTtl ?? 8;
    this.discoveryTtl = opts.discoveryTtl ?? 3;
    this.heartbeatMs = opts.heartbeatMs ?? 4000;
    this.compress = (opts.compress ?? true) && compressionSupported();
    // Lower threshold vs the old 256 B default: levelpack has no fixed header
    // overhead so it's worth trying even on short bodies (chat, ping, game events).
    this.compressThreshold = opts.compressThreshold ?? 64;
    // 'auto' tries all three codecs and picks the smallest each time.
    this.bodyCodec = opts.bodyCodec ?? 'auto';
    // 0 = classic flood (every direct neighbour via sendAll). ≥1 = gossip with that fanout.
    this.gossipFanout = Math.max(0, Math.floor(opts.gossipFanout ?? 0));
    // Default to unicast: directed messages follow the Dijkstra shortest path when one is
    // known, and fall back to flooding when it isn't — so it's strictly a superset of flood.
    this.router = new Router({ selfId: this.id, mode: opts.routing ?? 'unicast' });
    this.store = new ForwardStore({ holdMs: opts.storeMs, capacity: opts.storeCapacity });
    // Built-in ping responder so every node (bots included) answers a ping.
    // Also fire the scene robot's "responding" glow (green) when we receive a ping.
    this.on('mesh.ping', (ctx) => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('master_program:ping:confirmed'));
      }
      ctx.reply({ ts: Date.now() });
    });
  }

  // ── Transports ─────────────────────────────────────────────────────────────

  addTransport(t: Transport): this {
    this.transports.push(t);
    return this;
  }

  neighbors(): string[] {
    return this.transports.flatMap((t) => t.neighbors());
  }

  knownPeers(): PeerRecord[] {
    return [...this.peers.values()].sort((a, b) => a.hops - b.hops || a.label.localeCompare(b.label));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    for (const t of this.transports) {
      this.unsubs.push(
        t.on('frame', ({ frame, from }) => {
          this.peerToTransport.set(from, t);
          this.onIncoming(frame, from);
        }),
        t.on('peerUp', ({ peer }) => {
          this.peerToTransport.set(peer, t);
          this.sayHello(); // greet the new neighbour promptly
          this.replayTo(peer); // store-and-forward: catch the newcomer up on held frames
        }),
        t.on('peerDown', ({ peer }) => {
          this.peerToTransport.delete(peer);
          this.dropPeersVia(peer);
        }),
      );
      // A single transport failing to start (e.g. UDP multicast blocked) must not
      // take down the whole node — the others should still run.
      try {
        await t.start();
      } catch (err) {
        console.error(`[mesh] transport "${t.name}" failed to start`, err);
      }
    }

    this.sayHello();
    this.heartbeat = setInterval(() => {
      this.sayHello();
      this.expirePeers();
      this.store.prune(Date.now());
    }, this.heartbeatMs);

    this.events.emit('started', undefined);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    // Handoff: announce our departure (+ who we could reach) before the transports go
    // down, so peers — even ones several hops away — converge now instead of waiting out
    // the staleness timeout. Sent while transports are still up; the frame is on its way
    // before we tear down.
    this.sayBye();
    this.running = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    // Let services release their own resources (timers, listeners) before the transports
    // go down, so nothing keeps ticking against a torn-down node.
    for (const s of this.serviceObjects) {
      try { s.detach?.(this); } catch (err) { console.error(`[mesh] service "${s.name}" detach failed`, err); }
    }
    for (const t of this.transports) {
      try {
        await t.stop();
      } catch (err) {
        console.error(`[mesh] transport "${t.name}" failed to stop`, err);
      }
    }
    this.pending.forEach((p) => {
      clearTimeout(p.timer);
      p.reject(new Error('mesh: node stopped'));
    });
    this.pending.clear();
    this.events.emit('stopped', undefined);
  }

  // ── Services ─────────────────────────────────────────────────────────────────

  use<API>(service: MeshService<API>): API {
    const api = service.attach(this);
    this.services.set(service.name, api);
    this.serviceObjects.push(service); // remembered so stop() can detach (timers/listeners)
    return api;
  }

  service<API>(name: string): API | undefined {
    return this.services.get(name) as API | undefined;
  }

  /**
   * Turn the mesh into a private/isolated one. With a passphrase set, every app
   * payload (chat, trade, stream, game) is compacted + encrypted (gzip → AES-GCM)
   * so only nodes sharing the passphrase can read it. Control traffic (hello/ping)
   * stays clear so discovery still works. Pass null to go back to the open mesh.
   */
  setSecret(passphrase: string | null): void {
    this.secure = passphrase ? createSecureChannel(passphrase) : null;
    this.secretKey = passphrase || null;
  }

  /** Whether this node is on a private (encrypted) mesh. */
  get encrypted(): boolean {
    return this.secure !== null;
  }

  /** Current group key (the passphrase), or null on the open mesh. */
  get groupKey(): string | null {
    return this.secretKey;
  }

  // ── Messaging ────────────────────────────────────────────────────────────────

  /** Directed fire-and-forget message to a specific node. */
  send(to: NodeId, type: string, body: unknown): string {
    return this.originate({ to, type, body });
  }

  /** Flood a message to the whole reachable mesh. */
  broadcast(type: string, body: unknown): string {
    return this.originate({ to: null, type, body });
  }

  /** Publish on a pub/sub channel (delivered to every subscriber in range). */
  publish(channel: string, type: string, body: unknown): string {
    return this.originate({ to: null, type, body, channel });
  }

  /** Subscribe to a channel. Returns an unsubscribe fn. */
  subscribe(channel: string, handler: MessageHandler): () => void {
    const set = this.channels.get(channel) ?? new Set();
    set.add(handler);
    this.channels.set(channel, set);
    return () => set.delete(handler);
  }

  /** Low-level: handle every message of a given type. Returns an unsubscribe fn. */
  on(type: string, handler: MessageHandler): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
    return () => set.delete(handler);
  }

  /** Request/reply across the mesh. Resolves with the reply body, or rejects on timeout. */
  request(to: NodeId, type: string, body: unknown, timeoutMs = 8000): Promise<unknown> {
    const corr = globalThis.crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(corr);
        reject(new Error(`mesh: request "${type}" to ${to} timed out`));
      }, timeoutMs);
      this.pending.set(corr, { resolve, reject, timer });
      this.originate({ to, type, body, corr });
    });
  }

  /** Ping a peer and resolve with the round-trip time in ms. */
  async ping(to: NodeId, timeoutMs = 5000): Promise<number> {
    const t0 = Date.now();
    await this.request(to, 'mesh.ping', {}, timeoutMs);
    return Date.now() - t0;
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private originate(opts: {
    to: NodeId | null;
    type: string;
    body: unknown;
    channel?: string;
    corr?: string;
    reply?: boolean;
    ttl?: number;
  }): string {
    const env: Envelope = {
      v: PROTOCOL_VERSION,
      id: globalThis.crypto.randomUUID(),
      type: opts.type,
      from: this.id,
      to: opts.to,
      channel: opts.channel,
      ttl: opts.ttl ?? this.defaultTtl,
      path: [this.id],
      ts: Date.now(),
      corr: opts.corr,
      reply: opts.reply,
      body: opts.body,
    };
    this.router.noteOwn(env.id);

    // Deliver our own broadcasts/publishes to local subscribers too, so a node
    // sees what it sent on a channel it's subscribed to (e.g. chat echo). Uses the
    // plaintext body (we wrote it). Skip hello beacons and replies.
    if (opts.to === null && opts.type !== HELLO && opts.type !== BYE && !opts.reply) {
      queueMicrotask(() => this.deliver(env, this.id, Date.now()));
    }

    // On a private mesh, seal app payloads (gzip + AES-GCM) before they leave.
    // Control traffic (hello/ping) stays clear so discovery keeps working.
    const isControl = opts.type === HELLO || opts.type === BYE || opts.type === 'mesh.ping';
    if (this.secure && !isControl) {
      this.secure
        .seal(env.body)
        .then((sealed) => this.route({ ...env, enc: true, body: sealed }))
        .catch((err) => console.error('[mesh] seal failed', err));
    } else if (this.compress && !isControl && encodedSize(env.body) >= this.compressThreshold) {
      // Open mesh: compress payloads to save bandwidth.
      // 'auto' picks the smallest codec per message; explicit codec forces one.
      // `zc` is omitted when the winner is gzip for backward compatibility.
      const bodyCodec = this.bodyCodec;
      const pick = bodyCodec === 'auto'
        ? packBodySmallest(env.body)
        : packBody(env.body, bodyCodec).then((data) => ({ codec: bodyCodec as BodyCodec, data }));
      pick
        .then(({ codec, data }) =>
          this.route({ ...env, zip: true, ...(codec === 'gzip' ? {} : { zc: codec }), body: data }),
        )
        .catch(() => this.route(env)); // compression unavailable → send plain
    } else {
      this.route(env);
    }
    return env.id;
  }

  /** Send an (already-built) envelope onward: unicast via a learned route, else flood. */
  private route(env: Envelope): void {
    this.carry(env);
    const route = env.to ? this.router.routeFor(env.to) : undefined;
    if (route) this.transmitTo(route.via, env);
    else this.flood(env, null);
  }

  private onIncoming(frame: Uint8Array, fromPeer: string): void {
    const now = Date.now();
    const res = this.router.handle(frame, fromPeer, now);
    if (res.deliver) this.dispatch(res.deliver, fromPeer, now);
    if (res.forward) {
      const { env, plan } = res.forward;
      this.carry(env); // hold relayed frames too, so late-joiners still get them
      if (plan.kind === 'unicast') this.transmitTo(plan.via, env);
      else this.flood(env, plan.except);
    }
  }

  private dispatch(env: Envelope, fromPeer: string, now: number): void {
    // Hello beacons drive peer discovery and never reach app handlers (always clear).
    if (env.type === HELLO) {
      this.notePeer(env, fromPeer, now);
      return;
    }
    // Farewell beacons: a peer is leaving gracefully — drop it now (don't wait for the
    // timeout) and learn the contacts it handed off. Always clear, never app-visible.
    if (env.type === BYE) {
      this.noteBye(env);
      return;
    }
    // Sealed payload: decrypt before delivery. Without the passphrase we can't read
    // it, so drop silently — that's the point of a private mesh.
    if (env.enc) {
      if (!this.secure) return;
      this.secure
        .open(env.body as JsonTransportEnvelope)
        .then((body) => this.deliver({ ...env, enc: false, body }, fromPeer, now))
        .catch(() => {}); // wrong passphrase / corrupt frame
      return;
    }
    // Compressed payload: inflate before delivery, using the codec the sender
    // declared (`zc`; absent == 'gzip', so pre-levelpack frames still read).
    if (env.zip) {
      unpackBody(env.body as string, env.zc ?? 'gzip')
        .then((body) => this.deliver({ ...env, zip: false, zc: undefined, body }, fromPeer, now))
        .catch(() => {});
      return;
    }
    this.deliver(env, fromPeer, now);
  }

  private deliver(env: Envelope, _fromPeer: string, _now: number): void {
    // Replies resolve a pending request.
    if (env.reply && env.corr) {
      const pending = this.pending.get(env.corr);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(env.corr);
        pending.resolve(env.body);
      }
      return;
    }

    const ctx: MessageContext = {
      envelope: env,
      from: env.from,
      type: env.type,
      channel: env.channel,
      body: env.body,
      reply: (body: unknown) => {
        if (!env.corr) return; // not a request — nothing to reply to
        this.originate({ to: env.from, type: env.type, body, corr: env.corr, reply: true });
      },
    };

    this.events.emit('message', ctx);
    this.handlers.get(env.type)?.forEach((h) => h(ctx));
    if (env.channel) this.channels.get(env.channel)?.forEach((h) => h(ctx));
  }

  private sayHello(): void {
    // Gossip our direct neighbours alongside identity so peers can build route graphs.
    const body = { ...this.info, neighbors: this.neighbors() };
    this.originate({ to: null, type: HELLO, body, ttl: this.discoveryTtl });
  }

  /** Farewell on graceful exit: tell the mesh we're leaving + hand off our neighbours. */
  private sayBye(): void {
    const body = { ...this.info, neighbors: this.neighbors() };
    this.originate({ to: null, type: BYE, body, ttl: this.discoveryTtl });
  }

  /** A peer announced it's leaving: drop it immediately (skip the staleness wait). The
   * handed-off neighbour list rides in the record for graph/reconnect consumers. */
  private noteBye(env: Envelope): void {
    const info = env.body as NodeInfo & { neighbors?: NodeId[] };
    if (!info || typeof info.id !== 'string' || info.id === this.id) return;
    const rec = this.peers.get(info.id);
    if (!rec) return;
    if (Array.isArray(info.neighbors)) rec.neighbors = info.neighbors; // last known contacts
    this.peers.delete(info.id);
    this.recomputeRoutes();
    this.events.emit('peer:leave', rec);
  }

  private notePeer(env: Envelope, fromPeer: string, now: number): void {
    const info = env.body as NodeInfo & { neighbors?: NodeId[] };
    if (!info || typeof info.id !== 'string') return;
    const route = this.router.routeFor(info.id);
    const hops = route?.hops ?? Math.max(0, env.path.length - 1);
    const existing = this.peers.get(info.id);
    const record: PeerRecord = {
      id: info.id,
      label: info.label ?? info.id,
      caps: info.caps ?? [],
      via: fromPeer,
      neighbors: Array.isArray(info.neighbors) ? info.neighbors : [],
      hops,
      lastSeen: now,
      direct: hops === 0,
    };
    this.peers.set(info.id, record);
    this.recomputeRoutes();
    this.events.emit(existing ? 'peer:update' : 'peer:join', record);
  }

  /**
   * Rebuild the shortest-path route table from the gossiped topology and push it to the
   * router. Each peer's HELLO carries its direct neighbours, so assembling them gives a
   * view of the whole island; Dijkstra then yields the first hop toward every node. The
   * first hop is always a direct neighbour, so we resolve it to that neighbour's learned
   * transport handle (`via`). Cheap at island scale (≤6 nodes) — fine to run on each change.
   */
  private recomputeRoutes(): void {
    const adjacency = new Map<NodeId, Set<NodeId>>();
    const link = (a: NodeId, b: NodeId): void => {
      if (!a || !b || a === b) return;
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      if (!adjacency.has(b)) adjacency.set(b, new Set());
      adjacency.get(a)!.add(b);
      adjacency.get(b)!.add(a);
    };
    for (const rec of this.peers.values()) {
      if (rec.direct) link(this.id, rec.id); // self ↔ our direct neighbours
      for (const n of rec.neighbors) link(rec.id, n); // peer ↔ its gossiped neighbours
    }

    const now = Date.now();
    const computed = new Map<NodeId, Route>();
    for (const [dest, path] of shortestPaths(this.id, adjacency)) {
      const via = this.peers.get(path.nextHop)?.via;
      if (via === undefined) continue; // can't resolve a handle → leave to reverse-path / flood
      // shortestPaths counts edges (direct neighbour = 1); the mesh counts relays
      // (direct = 0, like Router's path.length - 1). Convert so peer hop counts line up.
      computed.set(dest, { via, hops: Math.max(0, path.hops - 1), ts: now });
    }
    this.router.setComputedRoutes(computed);
  }

  private expirePeers(): void {
    const cutoff = Date.now() - this.heartbeatMs * 3;
    let changed = false;
    for (const [id, rec] of this.peers) {
      if (rec.lastSeen < cutoff) {
        this.peers.delete(id);
        changed = true;
        this.events.emit('peer:leave', rec);
      }
    }
    if (changed) this.recomputeRoutes();
  }

  private dropPeersVia(peer: string): void {
    let changed = false;
    for (const [id, rec] of this.peers) {
      if (rec.via === peer && rec.direct) {
        this.peers.delete(id);
        changed = true;
        this.events.emit('peer:leave', rec);
      }
    }
    if (changed) this.recomputeRoutes();
  }

  /**
   * Store-and-forward capture: hold a carry-worthy frame so we can replay it to peers
   * that appear later. Skips control/transient traffic (hello, ping, replies) — those
   * make no sense to resurrect. We store the exact on-wire envelope (sealed/zipped as
   * sent), so replay is byte-identical and the receiver dedups it cleanly.
   */
  private carry(env: Envelope): void {
    if (!this.store.enabled) return;
    if (env.type === HELLO || env.type === BYE || env.type === 'mesh.ping' || env.reply) return;
    this.store.put(env.id, encode(env), env.to, Date.now());
  }

  /** Replay held frames to a peer that just came up: broadcasts to everyone, a unicast
   * only when its destination itself is the newcomer (the mule reached the target). */
  private replayTo(peer: string): void {
    if (!this.store.enabled) return;
    const t = this.peerToTransport.get(peer);
    if (!t) return;
    for (const f of this.store.pending(Date.now())) {
      if (f.to === null || f.to === peer) t.sendTo(peer, f.frame);
    }
  }

  private flood(env: Envelope, except: string | null): void {
    const frame = encode(env);

    // Classic flood: send via every transport's sendAll. Each transport applies `except`
    // (skip the neighbour the frame came from). Cheap and reliable on small islands.
    if (this.gossipFanout <= 0) {
      for (const t of this.transports) {
        t.sendAll(frame, except ? { except } : undefined);
      }
      return;
    }

    // Gossip: pick `gossipFanout` direct neighbours uniformly at random and unicast to
    // each. Their relays repeat the process; the Router's dedup LRU suppresses copies, so
    // a low fanout still covers an island while cutting application-level echoes. Falls
    // back to sendAll when there aren't enough neighbours to subset — at that point gossip
    // and flood are identical anyway.
    const eligible: string[] = [];
    for (const peer of this.peerToTransport.keys()) {
      if (peer !== except) eligible.push(peer);
    }
    if (eligible.length <= this.gossipFanout) {
      for (const peer of eligible) this.peerToTransport.get(peer)!.sendTo(peer, frame);
      return;
    }
    // Fisher–Yates partial shuffle: O(fanout), no allocation of the full permutation.
    for (let i = 0; i < this.gossipFanout; i += 1) {
      const j = i + Math.floor(Math.random() * (eligible.length - i));
      const pick = eligible[j];
      eligible[j] = eligible[i];
      this.peerToTransport.get(pick)!.sendTo(pick, frame);
    }
  }

  private transmitTo(peer: string, env: Envelope): void {
    const t = this.peerToTransport.get(peer);
    if (t) t.sendTo(peer, encode(env));
    else this.flood(env, null); // route stale — fall back to flood
  }
}
