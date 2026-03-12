import { attachE2EEToReceiver, attachE2EEToSender, supportsInsertableStreams } from './e2ee';
import { decryptJson, encryptJson } from './crypto';

export type PeerState = {
  peerId: string;
  connected: boolean;
  lastSeenMs: number;
  speaking: boolean;
};

export type WebRTCConfig = {
  wsUrl: string;
  roomHash: string;
  peerId: string;
  roomKey: CryptoKey;
  iceServers: RTCIceServer[];
  onPeersChanged: (peers: Map<string, PeerState>) => void;
  onError: (err: string) => void;
  onE2EEStatus: (status: { supported: boolean; enabled: boolean }) => void;
};

type SignalMsg =
  | { type: 'welcome'; peers: string[] }
  | { type: 'peer-joined'; peerId: string }
  | { type: 'peer-left'; peerId: string }
  | { type: 'signal'; from: string; data: any }
  | { type: 'error'; code: string };

type PresenceMsg =
  | { t: 'presence'; at: number; speaking: boolean; id: string }
  | { t: 'bye'; at: number; id: string };

export class RadioRoom {
  private cfg: WebRTCConfig;
  private ws: WebSocket | null = null;
  private pcs = new Map<string, RTCPeerConnection>();
  private presenceCh = new Map<string, RTCDataChannel>();
  private remoteAudio = new Map<string, HTMLAudioElement>();
  private peers = new Map<string, PeerState>();
  private localStream: MediaStream | null = null;
  private presenceTimer: number | null = null;
  private reapTimer: number | null = null;
  private e2eeSupported = false;
  private e2eeEnabled = false;
  private receiverE2EEAttached = new WeakSet<RTCRtpReceiver>();

  constructor(cfg: WebRTCConfig) {
    this.cfg = cfg;
  }

  async start(localStream: MediaStream) {
    this.localStream = localStream;
    this.e2eeSupported = supportsInsertableStreams();
    this.e2eeEnabled = this.e2eeSupported; // required by project; fallback handled below.
    this.cfg.onE2EEStatus({ supported: this.e2eeSupported, enabled: this.e2eeEnabled });

    await this.connectWs();
    this.startPresenceLoops();
  }

  stop() {
    this.stopPresenceLoops();
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;

    for (const [peerId, pc] of this.pcs.entries()) {
      try {
        pc.close();
      } catch {}
      this.pcs.delete(peerId);
    }

    for (const el of this.remoteAudio.values()) {
      try {
        el.pause();
        el.srcObject = null;
      } catch {}
    }
    this.remoteAudio.clear();
    this.presenceCh.clear();
    this.peers.clear();
    this.cfg.onPeersChanged(new Map(this.peers));
  }

  setTalking(isTalking: boolean) {
    if (!this.localStream) return;
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = isTalking;
    }
  }

  private startPresenceLoops() {
    const sendHeartbeat = async () => {
      const msg: PresenceMsg = {
        t: 'presence',
        at: Date.now(),
        speaking: this.peers.get(this.cfg.peerId)?.speaking ?? false,
        id: this.cfg.peerId
      };
      const payload = await encryptJson(this.cfg.roomKey, msg);
      const ab = payload.buffer.slice(
        payload.byteOffset,
        payload.byteOffset + payload.byteLength
      ) as ArrayBuffer;
      for (const ch of this.presenceCh.values()) {
        if (ch.readyState === 'open') ch.send(new Uint8Array(ab));
      }
    };

    this.presenceTimer = window.setInterval(() => {
      sendHeartbeat().catch(() => {});
    }, 1200);

    this.reapTimer = window.setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [peerId, st] of this.peers.entries()) {
        if (peerId === this.cfg.peerId) continue;
        if (now - st.lastSeenMs > 6000) {
          this.peers.delete(peerId);
          changed = true;
        }
      }
      if (changed) this.cfg.onPeersChanged(new Map(this.peers));
    }, 1500);
  }

  private stopPresenceLoops() {
    if (this.presenceTimer) window.clearInterval(this.presenceTimer);
    if (this.reapTimer) window.clearInterval(this.reapTimer);
    this.presenceTimer = null;
    this.reapTimer = null;
  }

  setLocalSpeaking(speaking: boolean) {
    const self = this.peers.get(this.cfg.peerId);
    if (!self) return;
    if (self.speaking === speaking) return;
    self.speaking = speaking;
    self.lastSeenMs = Date.now();
    this.peers.set(this.cfg.peerId, self);
    this.cfg.onPeersChanged(new Map(this.peers));
  }

  private ensureSelfPeer() {
    if (this.peers.has(this.cfg.peerId)) return;
    this.peers.set(this.cfg.peerId, {
      peerId: this.cfg.peerId,
      connected: true,
      lastSeenMs: Date.now(),
      speaking: false
    });
    this.cfg.onPeersChanged(new Map(this.peers));
  }

  private async connectWs() {
    this.ensureSelfPeer();
    this.ws = new WebSocket(this.cfg.wsUrl);

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error('ws missing'));
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('ws error'));
    });

    this.ws.onmessage = (ev) => {
      let msg: SignalMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onSignal(msg).catch(() => {});
    };

    this.ws.onclose = () => {
      this.cfg.onError('Disconnected from signaling server.');
    };

    this.ws.send(
      JSON.stringify({
        type: 'hello',
        roomHash: this.cfg.roomHash,
        peerId: this.cfg.peerId,
        client: 'open-radio-web'
      })
    );
  }

  private async onSignal(msg: SignalMsg) {
    if (msg.type === 'error') {
      this.cfg.onError(`Signaling error: ${msg.code}`);
      return;
    }
    if (msg.type === 'welcome') {
      // connect to existing peers
      for (const peerId of msg.peers) {
        this.ensurePeer(peerId);
        await this.ensurePC(peerId);
      }
      return;
    }
    if (msg.type === 'peer-joined') {
      this.ensurePeer(msg.peerId);
      await this.ensurePC(msg.peerId);
      return;
    }
    if (msg.type === 'peer-left') {
      this.dropPeer(msg.peerId);
      return;
    }
    if (msg.type === 'signal') {
      const from = msg.from;
      this.ensurePeer(from);
      const pc = await this.ensurePC(from);
      const data = msg.data;
      if (data?.kind === 'offer') {
        await pc.setRemoteDescription(data.sdp);
        await this.maybeAttachE2EEToReceivers(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sendSignal(from, { kind: 'answer', sdp: pc.localDescription });
      } else if (data?.kind === 'answer') {
        await pc.setRemoteDescription(data.sdp);
        await this.maybeAttachE2EEToReceivers(pc);
      } else if (data?.kind === 'ice') {
        if (data.candidate) await pc.addIceCandidate(data.candidate);
      }
      return;
    }
  }

  private ensurePeer(peerId: string) {
    if (peerId === this.cfg.peerId) return;
    const now = Date.now();
    const st = this.peers.get(peerId);
    if (st) {
      st.lastSeenMs = now;
      this.peers.set(peerId, st);
    } else {
      this.peers.set(peerId, { peerId, connected: false, lastSeenMs: now, speaking: false });
    }
    this.cfg.onPeersChanged(new Map(this.peers));
  }

  private dropPeer(peerId: string) {
    const pc = this.pcs.get(peerId);
    if (pc) {
      try {
        pc.close();
      } catch {}
    }
    this.pcs.delete(peerId);
    this.presenceCh.delete(peerId);
    const el = this.remoteAudio.get(peerId);
    if (el) {
      try {
        el.pause();
        el.srcObject = null;
      } catch {}
    }
    this.remoteAudio.delete(peerId);
    this.peers.delete(peerId);
    this.cfg.onPeersChanged(new Map(this.peers));
  }

  private sendSignal(to: string, data: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'signal', to, data }));
  }

  private async ensurePC(peerId: string): Promise<RTCPeerConnection> {
    const existing = this.pcs.get(peerId);
    if (existing) return existing;
    if (!this.localStream) throw new Error('local stream missing');

    const pc = new RTCPeerConnection({ iceServers: this.cfg.iceServers });
    this.pcs.set(peerId, pc);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.sendSignal(peerId, { kind: 'ice', candidate: ev.candidate });
    };

    pc.onconnectionstatechange = () => {
      const st = this.peers.get(peerId);
      if (!st) return;
      st.connected = pc.connectionState === 'connected';
      st.lastSeenMs = Date.now();
      this.peers.set(peerId, st);
      this.cfg.onPeersChanged(new Map(this.peers));
    };

    pc.ontrack = async (ev) => {
      // Attach remote audio to an element so it plays.
      const stream = ev.streams[0];
      if (!stream) return;

      let el = this.remoteAudio.get(peerId);
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true;
        el.setAttribute('playsinline', 'true');
        el.volume = 1.0;
        document.body.appendChild(el);
        this.remoteAudio.set(peerId, el);
      }
      el.srcObject = stream;
    };

    // Data channel for presence
    const isOfferer = this.cfg.peerId < peerId;
    if (isOfferer) {
      const ch = pc.createDataChannel('presence', { ordered: false, maxRetransmits: 0 });
      this.setupPresenceChannel(peerId, ch);
    } else {
      pc.ondatachannel = (ev) => {
        if (ev.channel.label === 'presence') this.setupPresenceChannel(peerId, ev.channel);
      };
    }

    // Add local audio track
    for (const track of this.localStream.getTracks()) {
      pc.addTrack(track, this.localStream);
    }

    // Attach E2EE to sender early.
    if (this.e2eeEnabled) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'audio') continue;
        await attachE2EEToSender(sender, this.cfg.roomKey);
      }
    }

    // Negotiate if offerer
    if (isOfferer) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal(peerId, { kind: 'offer', sdp: pc.localDescription });
    }

    return pc;
  }

  private async maybeAttachE2EEToReceivers(pc: RTCPeerConnection) {
    if (!this.e2eeEnabled) return;
    // Must be called as early as possible after setting the remote description.
    for (const receiver of pc.getReceivers()) {
      if (receiver.track?.kind !== 'audio') continue;
      if (this.receiverE2EEAttached.has(receiver)) continue;
      try {
        await attachE2EEToReceiver(receiver, this.cfg.roomKey);
        this.receiverE2EEAttached.add(receiver);
      } catch {
        // Some browsers throw "Too late to create encoded streams"; ignore.
      }
    }
  }

  private setupPresenceChannel(peerId: string, ch: RTCDataChannel) {
    this.presenceCh.set(peerId, ch);
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (ev) => {
      const handle = async () => {
        const bytes = new Uint8Array(ev.data as ArrayBuffer);
        const msg = await decryptJson<PresenceMsg>(this.cfg.roomKey, bytes);
        if (msg.t === 'presence') {
          const st = this.peers.get(peerId) ?? {
            peerId,
            connected: true,
            lastSeenMs: Date.now(),
            speaking: false
          };
          st.lastSeenMs = Date.now();
          st.speaking = !!msg.speaking;
          this.peers.set(peerId, st);
          this.cfg.onPeersChanged(new Map(this.peers));
        }
      };
      handle().catch(() => {});
    };
    ch.onopen = () => {
      const st = this.peers.get(peerId);
      if (!st) return;
      st.lastSeenMs = Date.now();
      this.peers.set(peerId, st);
      this.cfg.onPeersChanged(new Map(this.peers));
    };
    ch.onclose = () => {};
  }
}

