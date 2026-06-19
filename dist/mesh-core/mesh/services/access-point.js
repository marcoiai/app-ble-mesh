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
const CANDIDACY = 'ap.candidacy';
const CREDS = 'ap.creds';
/** Higher = better host. Battery dominates; well-connected nodes get a nudge. */
function score(c) {
    return c.battery + c.neighborCount * 2;
}
export function accessPointService(opts = {}) {
    const announceMs = opts.announceMs ?? 2500;
    const staleMs = opts.staleMs ?? announceMs * 3;
    const candidacies = new Map();
    let creds = null;
    let electedId = null;
    const self = { battery: 50, canHost: opts.canHost ?? false };
    let onBecomeAp = null;
    let onCredentials = null;
    const changeListeners = new Set();
    let timer = null;
    const unsubs = [];
    return {
        name: 'access-point',
        attach(node) {
            const myCandidacy = () => ({
                nodeId: node.id,
                label: node.info.label,
                battery: self.battery,
                neighborCount: node.knownPeers().filter((p) => p.direct).length,
                canHost: self.canHost,
                ts: Date.now(),
            });
            // We won the election: ask the native layer to bring a hotspot up, then flood its
            // credentials so the others can join. Idempotent per term (guarded on !creds).
            const becomeAp = () => {
                if (creds && creds.apNodeId === node.id)
                    return; // already hosting this term
                void Promise.resolve(onBecomeAp?.()).then((c) => {
                    if (!c || electedId !== node.id)
                        return; // lost the role while bringing it up
                    creds = { ...c, apNodeId: node.id, ts: Date.now() };
                    node.broadcast(CREDS, creds);
                });
            };
            // Pure, deterministic: same inputs → same winner on every node (no coordinator).
            const elect = () => {
                const now = Date.now();
                for (const [id, c] of candidacies) {
                    if (now - c.ts > staleMs)
                        candidacies.delete(id);
                }
                candidacies.set(node.id, myCandidacy()); // always weigh ourselves, fresh
                let winner = null;
                for (const c of candidacies.values()) {
                    if (!c.canHost)
                        continue; // only nodes that can actually host are eligible
                    const better = !winner ||
                        score(c) > score(winner) ||
                        (score(c) === score(winner) && c.nodeId < winner.nodeId); // stable tie-break
                    if (better)
                        winner = c;
                }
                const next = winner ? winner.nodeId : null;
                if (next === electedId)
                    return;
                electedId = next;
                if (creds && creds.apNodeId !== electedId)
                    creds = null; // last AP's creds are stale now
                for (const fn of changeListeners)
                    fn(electedId);
                if (electedId === node.id) {
                    becomeAp();
                }
                else if (electedId && creds?.apNodeId === electedId) {
                    onCredentials?.(creds); // already hold this AP's creds — join right away
                }
            };
            const announce = () => {
                node.broadcast(CANDIDACY, myCandidacy());
                elect();
            };
            unsubs.push(node.on(CANDIDACY, (ctx) => {
                const c = ctx.body;
                if (!c || typeof c.nodeId !== 'string' || c.nodeId === node.id)
                    return;
                candidacies.set(c.nodeId, c);
                elect();
            }));
            unsubs.push(node.on(CREDS, (ctx) => {
                const c = ctx.body;
                if (!c || typeof c.apNodeId !== 'string' || typeof c.ssid !== 'string')
                    return;
                creds = c;
                if (c.apNodeId === electedId && c.apNodeId !== node.id)
                    onCredentials?.(c);
            }));
            unsubs.push(node.events.on('peer:leave', (rec) => {
                candidacies.delete(rec.id);
                elect(); // the AP may have just left — re-elect immediately (self-heal)
            }));
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
                    if (typeof input.canHost === 'boolean')
                        self.canHost = input.canHost;
                    announce();
                },
                onBecomeAp: (fn) => {
                    onBecomeAp = fn;
                    // If the election already settled on us before this callback was wired, fire now.
                    if (electedId === node.id)
                        becomeAp();
                },
                onCredentials: (fn) => { onCredentials = fn; },
                onChange: (fn) => { changeListeners.add(fn); return () => changeListeners.delete(fn); },
            };
        },
        detach() {
            if (timer)
                clearInterval(timer);
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
