type EncodedChunk = {
  data: ArrayBuffer;
  type?: string;
  timestamp?: number;
  getMetadata?: () => any;
};

function hasCreateEncodedStreams(x: any): x is { createEncodedStreams: () => any } {
  return x && typeof x.createEncodedStreams === 'function';
}

export function supportsInsertableStreams(): boolean {
  // Chromium supports createEncodedStreams; Safari/Firefox may not.
  return (
    typeof window !== 'undefined' &&
    typeof RTCRtpSender !== 'undefined' &&
    typeof (RTCRtpSender as any).prototype?.createEncodedStreams === 'function'
  );
}

export async function attachE2EEToSender(sender: RTCRtpSender, key: CryptoKey) {
  if (!hasCreateEncodedStreams(sender)) return false;
  const streams = sender.createEncodedStreams();
  const aad = new TextEncoder().encode('open-radio/audio/v1');

  const transform = new TransformStream<EncodedChunk, EncodedChunk>({
    async transform(chunk, controller) {
      try {
        const pt = new Uint8Array(chunk.data);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: iv as unknown as BufferSource,
            additionalData: aad as unknown as BufferSource
          },
          key,
          pt
        );
        const out = new Uint8Array(iv.byteLength + ct.byteLength);
        out.set(iv, 0);
        out.set(new Uint8Array(ct), iv.byteLength);
        chunk.data = out.buffer;
        controller.enqueue(chunk);
      } catch {
        // Drop frame if encryption fails.
      }
    }
  });

  streams.readable.pipeThrough(transform).pipeTo(streams.writable);
  return true;
}

export async function attachE2EEToReceiver(receiver: RTCRtpReceiver, key: CryptoKey) {
  if (!hasCreateEncodedStreams(receiver)) return false;
  const streams = (receiver as any).createEncodedStreams();
  const aad = new TextEncoder().encode('open-radio/audio/v1');

  const transform = new TransformStream<EncodedChunk, EncodedChunk>({
    async transform(chunk, controller) {
      try {
        const bytes = new Uint8Array(chunk.data);
        if (bytes.byteLength < 13) return;
        const iv = bytes.slice(0, 12);
        const body = bytes.slice(12);
        const pt = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: iv as unknown as BufferSource,
            additionalData: aad as unknown as BufferSource
          },
          key,
          body
        );
        chunk.data = pt;
        controller.enqueue(chunk);
      } catch {
        // Drop undecipherable frame.
      }
    }
  });

  streams.readable.pipeThrough(transform).pipeTo(streams.writable);
  return true;
}

