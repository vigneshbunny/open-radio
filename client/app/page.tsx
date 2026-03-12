'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { deriveRoomKey, roomHash } from '../lib/crypto';
import { randomId } from '../lib/ids';
import type { PeerState } from '../lib/webrtc';
import { RadioRoom } from '../lib/webrtc';

// IMPORTANT: In Next.js client bundles, avoid dynamic `process.env[name]` access.
// Only `process.env.NEXT_PUBLIC_*` direct reads are safely inlined at build time.
const SIGNALING_URL = process.env.NEXT_PUBLIC_SIGNALING_URL;
const TURN_URL = process.env.NEXT_PUBLIC_TURN_URL;
const TURN_USERNAME = process.env.NEXT_PUBLIC_TURN_USERNAME;
const TURN_PASSWORD = process.env.NEXT_PUBLIC_TURN_PASSWORD;

function defaultIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

  const turnUrl = TURN_URL;
  const turnUsername = TURN_USERNAME;
  const turnPassword = TURN_PASSWORD;
  if (turnUrl && turnUsername && turnPassword) {
    servers.push({ urls: turnUrl, username: turnUsername, credential: turnPassword });
  }
  return servers;
}

type Phase = 'idle' | 'joining' | 'in-room';

export default function HomePage() {
  const [frequency, setFrequency] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [err, setErr] = useState<string>('');
  const [peers, setPeers] = useState<Map<string, PeerState>>(new Map());
  const [isTalking, setIsTalking] = useState(false);
  // Avoid hydration mismatch: generate peerId only after mount.
  const [peerId, setPeerId] = useState('');
  const [e2ee, setE2ee] = useState<{ supported: boolean; enabled: boolean }>({
    supported: false,
    enabled: false
  });

  const roomRef = useRef<RadioRoom | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const rawMicStreamRef = useRef<MediaStream | null>(null);
  const speakingDetectorRef = useRef<{ stop: () => void } | null>(null);
  const roomKeyRef = useRef<CryptoKey | null>(null);
  const roomHashRef = useRef<string | null>(null);
  const rotateTimerRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const isTalkingRef = useRef(false);

  const listenerCount = useMemo(() => peers.size, [peers]);
  const speakingPeers = useMemo(() => {
    const out: string[] = [];
    for (const p of peers.values()) {
      if (p.speaking && p.connected) out.push(p.peerId);
    }
    return out;
  }, [peers]);

  const wsUrl = useMemo(() => {
    if (SIGNALING_URL) return SIGNALING_URL;
    if (typeof window === 'undefined') return 'ws://localhost:8787';
    const isHttps = window.location.protocol === 'https:';
    const host = window.location.hostname;
    const port = window.location.port;
    if (isHttps) {
      // Avoid mixed-content: HTTPS pages must use WSS. Default to same-origin proxy path.
      const originPort = port ? `:${port}` : '';
      return `wss://${host}${originPort}/signal`;
    }
    return `ws://${host}:8787`;
  }, []);

  useEffect(() => {
    setPeerId(randomId(12));
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        if (phase === 'in-room') setIsTalking(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        setIsTalking(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [phase]);

  useEffect(() => {
    isTalkingRef.current = isTalking;
    // True push-to-talk: gate outgoing audio at the source.
    if (gainRef.current) gainRef.current.gain.value = isTalking ? 1 : 0;
  }, [isTalking]);

  useEffect(() => {
    // Anonymous ID rotation: periodically reconnect with a fresh peerId.
    // This rotates only the "network identity", not the room secret.
    if (phase !== 'in-room') return;
    if (rotateTimerRef.current) window.clearInterval(rotateTimerRef.current);
    rotateTimerRef.current = window.setInterval(() => {
      rotateIdentity().catch(() => {});
    }, 20 * 60 * 1000);
    return () => {
      if (rotateTimerRef.current) window.clearInterval(rotateTimerRef.current);
      rotateTimerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    return () => {
      try {
        roomRef.current?.stop();
      } catch {}
      try {
        speakingDetectorRef.current?.stop();
      } catch {}
      for (const t of localStreamRef.current?.getTracks() || []) t.stop();
      localStreamRef.current = null;
    };
  }, []);

  async function join() {
    setErr('');
    const f = frequency.trim();
    if (!f) {
      setErr('Enter a frequency.');
      return;
    }
    if (!peerId) {
      setErr('Initializing… try again.');
      return;
    }

    setPhase('joining');
    try {
      const [rk, rh] = await Promise.all([deriveRoomKey(f), roomHash(f)]);
      roomKeyRef.current = rk;
      roomHashRef.current = rh;
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // Create an audio gate so we send true silence unless PTT is held.
      const ac = new AudioContext();
      const src = ac.createMediaStreamSource(micStream);
      const gain = ac.createGain();
      gain.gain.value = 0; // start muted
      const dest = ac.createMediaStreamDestination();
      src.connect(gain);
      gain.connect(dest);

      audioCtxRef.current = ac;
      gainRef.current = gain;

      const gatedStream = dest.stream;
      rawMicStreamRef.current = micStream;
      localStreamRef.current = gatedStream;

      const room = new RadioRoom({
        wsUrl,
        roomHash: rh,
        peerId,
        roomKey: rk,
        initialE2EEEnabled: false,
        iceServers: defaultIceServers(),
        onPeersChanged: setPeers,
        onError: setErr,
        onE2EEStatus: setE2ee
      });

      roomRef.current = room;
      await room.start(gatedStream);

      // Local speaking detector for UI + presence "speaking" bit.
      speakingDetectorRef.current = startSpeakingDetector(micStream, (speaking) =>
        room.setLocalSpeaking(isTalkingRef.current && speaking)
      );

      setPhase('in-room');
    } catch (e: any) {
      setErr(e?.message || String(e));
      setPhase('idle');
    }
  }

  async function rotateIdentity() {
    const f = frequency.trim();
    if (!f) return;
    const rk = roomKeyRef.current;
    const rh = roomHashRef.current;
    const localStream = localStreamRef.current;
    if (!rk || !rh || !localStream) return;

    // Fresh peer id + reconnect signaling/peers.
    const next = randomId(12);
    setPeerId(next);

    try {
      roomRef.current?.stop();
    } catch {}

    const room = new RadioRoom({
      wsUrl,
      roomHash: rh,
      peerId: next,
      roomKey: rk,
      initialE2EEEnabled: false,
      iceServers: defaultIceServers(),
      onPeersChanged: setPeers,
      onError: setErr,
      onE2EEStatus: setE2ee
    });
    roomRef.current = room;
    await room.start(localStream);
  }

  function leave() {
    setIsTalking(false);
    try {
      roomRef.current?.stop();
    } catch {}
    roomRef.current = null;

    try {
      speakingDetectorRef.current?.stop();
    } catch {}
    speakingDetectorRef.current = null;

    for (const t of localStreamRef.current?.getTracks() || []) t.stop();
    localStreamRef.current = null;
    for (const t of rawMicStreamRef.current?.getTracks() || []) t.stop();
    rawMicStreamRef.current = null;
    try {
      audioCtxRef.current?.close();
    } catch {}
    audioCtxRef.current = null;
    gainRef.current = null;

    setPeers(new Map());
    setPhase('idle');
  }

  const inRoom = phase === 'in-room';

  return (
    <div className="page">
      <div className="card">
        <div className="header">
          <div className="brand">
            <h1>OPEN RADIO</h1>
            <p>
              Global encrypted walkie-talkie. No accounts. Rooms are “frequencies”.
              <br />
              Hold <b>Space</b> or press and hold the button to talk.
            </p>
          </div>
          <div className="pill">
            <span>Signaling</span>
            <span className="small">{wsUrl}</span>
          </div>
        </div>

        <div className="grid">
          <div className="panel">
            {!inRoom ? (
              <>
                <div className="row">
                  <div style={{ flex: 1 }}>
                    <div className="small">Enter frequency</div>
                    <input
                      type="text"
                      placeholder="darkforest-773"
                      value={frequency}
                      onChange={(e) => setFrequency(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') join();
                      }}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </div>
                  <button
                    className="primary"
                    onClick={join}
                    disabled={phase === 'joining'}
                    style={{ minWidth: 120, height: 44, alignSelf: 'end' }}
                  >
                    {phase === 'joining' ? 'JOINING…' : 'JOIN'}
                  </button>
                </div>

                <div className="kv">
                  <div className="k">Listeners</div>
                  <div className="v">{listenerCount}</div>
                  <div className="k">E2EE</div>
                  <div className="v">
                    <span className="small muted">
                      Media E2EE in development (currently disabled)
                    </span>
                  </div>
                  <div className="k">Your ID</div>
                  <div className="v">
            <span className="small">{peerId}</span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <div className="small">Frequency</div>
                    <div style={{ fontWeight: 700, fontSize: 16 }}>{frequency.trim()}</div>
                  </div>
                  <button className="danger" onClick={leave}>
                    LEAVE
                  </button>
                </div>

                <div className="kv">
                  <div className="k">Listeners</div>
                  <div className="v">{listenerCount}</div>
                  <div className="k">Speaking now</div>
                  <div className="v">{speakingPeers.length}</div>
                  <div className="k">E2EE</div>
                  <div className="v">
                    {e2ee.enabled ? (
                      <span style={{ color: 'var(--good)' }}>Enabled</span>
                    ) : (
                      <span style={{ color: 'var(--warn)' }}>Not enabled</span>
                    )}
                  </div>
                </div>

                <div style={{ marginTop: 12 }}>
                  <button
                    className={`talk ${isTalking ? 'live' : ''}`}
                    onPointerDown={() => setIsTalking(true)}
                    onPointerUp={() => setIsTalking(false)}
                    onPointerLeave={() => setIsTalking(false)}
                  >
                    {isTalking ? 'TRANSMITTING… (release to stop)' : 'PRESS TO TALK'}
                  </button>
                  <div className="small muted" style={{ marginTop: 8 }}>
                    Tip: use a long random frequency for privacy. Anyone who knows the frequency can
                    join.
                  </div>
                </div>
              </>
            )}

            {err ? <div className="err">{err}</div> : null}
          </div>

          <div className="panel">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div style={{ fontWeight: 700 }}>Peers</div>
              <div className="small muted">{inRoom ? 'live' : 'not connected'}</div>
            </div>
            <div className="peers">
              {Array.from(peers.values())
                .sort((a, b) => a.peerId.localeCompare(b.peerId))
                .map((p) => (
                  <div className="peer" key={p.peerId}>
                    <div className="row" style={{ gap: 10 }}>
                      <div className={`dot ${p.speaking ? 'speaking' : ''}`} />
                      <div>
                        <div style={{ fontWeight: 650, fontSize: 13 }}>
                      {p.peerId === peerId ? 'You' : shortId(p.peerId)}
                        </div>
                        <div className="small">
                          {p.connected ? (
                            <span style={{ color: 'var(--good)' }}>connected</span>
                          ) : (
                            <span className="muted">connecting…</span>
                          )}
                          {' · '}
                          last seen {Math.max(0, Math.round((Date.now() - p.lastSeenMs) / 1000))}s
                          ago
                        </div>
                      </div>
                    </div>
                    <div className="small muted">{p.speaking ? 'speaking' : 'listening'}</div>
                  </div>
                ))}
              {peers.size === 0 ? <div className="small muted">No peers yet.</div> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function shortId(id: string) {
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function startSpeakingDetector(stream: MediaStream, onSpeaking: (s: boolean) => void) {
  const ac = new AudioContext();
  const src = ac.createMediaStreamSource(stream);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);

  let last = false;
  let raf = 0;

  const loop = () => {
    analyser.getByteTimeDomainData(data);
    // Compute RMS.
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);

    const speaking = rms > 0.03; // heuristic
    if (speaking !== last) {
      last = speaking;
      onSpeaking(speaking);
    }
    raf = requestAnimationFrame(loop);
  };

  raf = requestAnimationFrame(loop);

  return {
    stop() {
      cancelAnimationFrame(raf);
      try {
        src.disconnect();
        analyser.disconnect();
      } catch {}
      ac.close().catch(() => {});
    }
  };
}

