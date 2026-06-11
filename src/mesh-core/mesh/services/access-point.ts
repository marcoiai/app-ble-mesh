// ── Access-Point control plane — the "floating hotspot" ───────────────────────
// The BLE/Multipeer mesh is the always-on CONTROL PLANE; a WiFi hotspot is an optional
// high-bandwidth DATA PLANE whose host is a ROTATING role, not a fixed hub. Each node
// advertises its hosting fitness (battery, neighbour count, can-it-host); every node runs
// the SAME deterministic election, so they agree on one AP with no coordinator.
//
// When the AP drops, the BLE mesh still holds the island together (no SPOF) and the
// survivors re-elect instantly — that's the self-heal. The winner starts a local hotspot
// (native, platform-specific) and floods its SSID/passphrase over the mesh so the others
// can join. Starting/joining the real hotspot is the platform's job (Android
// startLocalOnlyHotspot, WiFiAdapter.ConnectAsync, …) — wired here via callbacks.
//
// See ARCHITECTURE.md → "Resilience: Control Plane vs Data Plane".

import type { MeshNode, MeshService } from '../node.ts';

export interface ApCandidacy {
  nodeId: string;
  label: string;
  /** Battery %, 0..100; 50 when unknown. Drains-fast hosts should not win. */
  battery: number;
  /** Direct neighbours — a well-connected node makes a better hub. */
  neighborCount: number;
  /** Whether this node's platform can actually start a hotspot (Android yes, macOS not yet). */
  canHost: boolean;
  ts: number;
}

export interface ApCredentials {
  apNodeId: string;
  ssid: string;
  pass: string;
  ts: number;
}

export interface AccessPointApi {
  /** Elected AP node id, or null when nobody can host. */
  current(): string | null;
  /** True when this node is the elected AP. */
  isSelf(): boolean;
  /** Latest credentials announced by the current AP, if any. */
  credentials(): ApCredentials | null;
  /** Everyone currently in the running (for a debug/visualiser). */
  candidates(): ApCandidacy[];
  /** Update this node's hosting fitness; re-announces + re-elects. */
  setFitness(input: { battery?: number; canHost?: boolean }): void;
  /** Provide the hotspot the native layer started when this node wins (its SSID/pass). */
  onBecomeAp(fn: () => ApCredentials | Promise<ApCredentials>): void;
  /** Called with fresh credentials this node should join (when it is NOT the AP). */
  onCredentials(fn: (creds: ApCredentials) => void): void;
  /** Notified whenever the elected AP changes. Returns an unsubscribe fn. */
  onChange(fn: (apId: string | null) => void): () => void;
}

export interface AccessPointOptions {
  /** How often to re-announce our candidacy (ms). */
  announceMs?: number;
  /** A candidacy older than this is ignored and dropped (ms). */
  staleMs?: number;
  /** Whether THIS node can host a hotspot. Default false (safe; set true on Android). */
  canHost?: boolean;
}

const CANDIDACY = 'ap.candidacy';
const CREDS = 'ap.creds';

/** Higher = better host. Battery dominates; well-connected nodes get a nudge. */
function score(c: ApCandidacy): number {
  return c.battery + c.neighborCount * 2;
}

export function accessPointService(opts: AccessPointOptions = {}): MeshService<AccessPointApi> {
  const announceMs = opts.announceMs ?? 2500;
  const staleMs = opts.staleMs ?? announceMs * 3;

  const candidacies = new Map<string, ApCandidacy>();
  let creds: ApCredentials | null = null;
  let electedId: string | null = null;
  const self = { battery: 50, canHost: opts.canHost ?? false };

  let onBecomeAp: (() => ApCredentials | Promise<ApCredentials>) | null = null;
  let onCredentials: ((c: ApCredentials) => void) | null = null;
  const changeListeners = new Set<(id: string | null) => void>();

  let timer: ReturnType<typeof setInterval> | null = null;
  const unsubs: Array<() => void> = [];

  return {
    name: 'access-point',

    attach(node: MeshNode): AccessPointApi {
      const myCandidacy = (): ApCandidacy => ({
        nodeId: node.id,
        label: node.info.label,
        battery: self.battery,
        neighborCount: node.knownPeers().filter((p) => p.direct).length,
        canHost: self.canHost,
        ts: Date.now(),
      });

      // We won the election: ask the native layer to bring a hotspot up, then flood its
      // credentials so the others can join. Idempotent per term (guarded on !creds).
      const becomeAp = (): void => {
        if (creds && creds.apNodeId === node.id) return; // already hosting this term
        void Promise.resolve(onBecomeAp?.()).then((c) => {
          if (!c || electedId !== node.id) return; // lost the role while bringing it up
          creds = { ...c, apNodeId: node.id, ts: Date.now() };
          node.broadcast(CREDS, creds);
        });
      };

      // Pure, deterministic: same inputs → same winner on every node (no coordinator).
      const elect = (): void => {
        const now = Date.now();
        for (const [id, c] of candidacies) {
          if (now - c.ts > staleMs) candidacies.delete(id);
        }
        candidacies.set(node.id, myCandidacy()); // always weigh ourselves, fresh

        let winner: ApCandidacy | null = null;
        for (const c of candidacies.values()) {
          if (!c.canHost) continue; // only nodes that can actually host are eligible
          const better =
            !winner ||
            score(c) > score(winner) ||
            (score(c) === score(winner) && c.nodeId < winner.nodeId); // stable tie-break
          if (better) winner = c;
        }

        const next = winner ? winner.nodeId : null;
        if (next === electedId) return;
        electedId = next;
        if (creds && creds.apNodeId !== electedId) creds = null; // last AP's creds are stale now
        for (const fn of changeListeners) fn(electedId);

        if (electedId === node.id) {
          becomeAp();
        } else if (electedId && creds?.apNodeId === electedId) {
          onCredentials?.(creds); // already hold this AP's creds — join right away
        }
      };

      const announce = (): void => {
        node.broadcast(CANDIDACY, myCandidacy());
        elect();
      };

      unsubs.push(
        node.on(CANDIDACY, (ctx) => {
          const c = ctx.body as ApCandidacy;
          if (!c || typeof c.nodeId !== 'string' || c.nodeId === node.id) return;
          candidacies.set(c.nodeId, c);
          elect();
        }),
      );
      unsubs.push(
        node.on(CREDS, (ctx) => {
          const c = ctx.body as ApCredentials;
          if (!c || typeof c.apNodeId !== 'string' || typeof c.ssid !== 'string') return;
          creds = c;
          if (c.apNodeId === electedId && c.apNodeId !== node.id) onCredentials?.(c);
        }),
      );
      unsubs.push(
        node.events.on('peer:leave', (rec) => {
          candidacies.delete(rec.id);
          elect(); // the AP may have just left — re-elect immediately (self-heal)
        }),
      );

      announce();
      timer = setInterval(announce, announceMs);

      return {
        current: () => electedId,
        isSelf: () => electedId === node.id,
        credentials: () => creds,
        candidates: () => [...candidacies.values()],
        setFitness: (input) => {
          if (typeof input.battery === 'number') {
            self.battery = Math.max(0, Math.min(100, input.battery));
          }
          if (typeof input.canHost === 'boolean') self.canHost = input.canHost;
          announce();
        },
        onBecomeAp: (fn) => {
          onBecomeAp = fn;
          // If the election already settled on us before this callback was wired, fire now.
          if (electedId === node.id) becomeAp();
        },
        onCredentials: (fn) => { onCredentials = fn; },
        onChange: (fn) => { changeListeners.add(fn); return () => changeListeners.delete(fn); },
      };
    },

    detach() {
      if (timer) clearInterval(timer);
      timer = null;
      unsubs.forEach((u) => u());
      unsubs.length = 0;
      candidacies.clear();
      changeListeners.clear();
      creds = null;
      electedId = null;
    },
  };
}
