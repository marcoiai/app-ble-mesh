// ── WebRTC transport (real) ──────────────────────────────────────────────────
// Real machine-to-machine peer-to-peer with NO server and NO internet required on
// the same local network: data flows directly over an RTCDataChannel. The only
// out-of-band step is exchanging a tiny invite/answer blob (copy-paste / AirDrop /
// QR) — there is no signalling server. Each completed handshake is one neighbour.
//
// Connectivity: defaults to host/mDNS ICE candidates (works between machines on the
// same Wi-Fi/LAN even offline). Pass `iceServers` (STUN) if you need to traverse
// different networks. The invite/answer blobs also carry each side's NodeId so the
// transport's peer handle == the remote NodeId (keeps routing/discovery consistent).

import { Emitter } from '../emitter.js';
import type { Transport, TransportEvents } from '../transport.js';

interface Signal {
  nodeId: string;
  sdp: RTCSessionDescriptionInit;
}

export interface WebRtcOptions {
  /** STUN/TURN servers. Empty (default) = host/mDNS only (same-LAN, offline-friendly). */
  iceServers?: RTCIceServer[];
  /** Max ms to wait for ICE gathering before emitting the blob. */
  iceTimeoutMs?: number;
}

function encodeSignal(sig: Signal): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(sig))));
}
function decodeSignal(text: string): Signal {
  return JSON.parse(decodeURIComponent(escape(atob(text.trim())))) as Signal;
}

export function webRtcSupported(): boolean {
  return typeof RTCPeerConnection !== 'undefined';
}

export class WebRtcTransport extends Emitter<TransportEvents> implements Transport {
  readonly name = 'webrtc';
  private localNodeId: string;
  private iceServers: RTCIceServer[];
  private iceTimeoutMs: number;
  private channels = new Map<string, RTCDataChannel>(); // remoteNodeId -> channel
  private pcs = new Map<string, RTCPeerConnection>();
  private pendingInitiator: { pc: RTCPeerConnection; dc: RTCDataChannel } | null = null;

  constructor(localNodeId: string, opts: WebRtcOptions = {}) {
    super();
    this.localNodeId = localNodeId;
    this.iceServers = opts.iceServers ?? [];
    this.iceTimeoutMs = opts.iceTimeoutMs ?? 3500;
  }

  start(): void {
    if (!webRtcSupported()) throw new Error('WebRTC not supported here');
  }

  stop(): void {
    this.channels.forEach((dc) => dc.close());
    this.pcs.forEach((pc) => pc.close());
    this.pendingInitiator?.pc.close();
    this.channels.clear();
    this.pcs.clear();
    this.pendingInitiator = null;
  }

  neighbors(): string[] {
    return [...this.channels.keys()];
  }

  sendTo(peer: string, frame: Uint8Array): void {
    const dc = this.channels.get(peer);
    if (dc && dc.readyState === 'open') dc.send(frame);
  }

  sendAll(frame: Uint8Array, opts?: { except?: string }): void {
    for (const [id, dc] of this.channels) {
      if (id === opts?.except) continue;
      if (dc.readyState === 'open') dc.send(frame);
    }
  }

  // ── Manual handshake (no signalling server) ───────────────────────────────────

  /** HOST step 1: create an invite blob to hand to the other machine. */
  async createInvite(): Promise<string> {
    const pc = this.newPc();
    const dc = pc.createDataChannel('mesh', { ordered: true });
    this.pendingInitiator = { pc, dc };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitForIce(pc);
    return encodeSignal({ nodeId: this.localNodeId, sdp: pc.localDescription! });
  }

  /** GUEST: paste the host's invite, get back an answer blob to send to the host. */
  async acceptInvite(inviteText: string): Promise<string> {
    const { nodeId: remoteId, sdp } = decodeSignal(inviteText);
    const pc = this.newPc();
    pc.ondatachannel = (ev) => this.bindChannel(remoteId, ev.channel);
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.waitForIce(pc);
    this.pcs.set(remoteId, pc);
    return encodeSignal({ nodeId: this.localNodeId, sdp: pc.localDescription! });
  }

  /** HOST step 2: paste the guest's answer to finish the connection. */
  async completeInvite(answerText: string): Promise<void> {
    const { nodeId: remoteId, sdp } = decodeSignal(answerText);
    if (!this.pendingInitiator) throw new Error('no pending invite — create one first');
    const { pc, dc } = this.pendingInitiator;
    this.pendingInitiator = null;
    this.bindChannel(remoteId, dc);
    this.pcs.set(remoteId, pc);
    await pc.setRemoteDescription(sdp);
  }

  // ── internals ─────────────────────────────────────────────────────────────────

  private newPc(): RTCPeerConnection {
    return new RTCPeerConnection({ iceServers: this.iceServers });
  }

  private bindChannel(remoteId: string, dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      this.channels.set(remoteId, dc);
      this.emit('peerUp', { peer: remoteId });
    };
    dc.onclose = () => {
      if (this.channels.delete(remoteId)) this.emit('peerDown', { peer: remoteId });
    };
    dc.onmessage = (ev: MessageEvent) => {
      const data = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array();
      this.emit('frame', { frame: data, from: remoteId });
    };
  }

  /** Resolve once ICE gathering completes (or after a timeout) so the blob is self-contained. */
  private waitForIce(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        pc.removeEventListener('icegatheringstatechange', check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      const timer = setTimeout(done, this.iceTimeoutMs);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }
}
