export async function sha256Bytes(input: string): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    // WebCrypto is only available in secure contexts (HTTPS) except on localhost.
    // When accessing from another machine over http://LAN-IP, browsers disable crypto.subtle.
    throw new Error(
      'WebCrypto is unavailable (crypto.subtle). Open this site over HTTPS (recommended) or via localhost.'
    );
  }
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return new Uint8Array(digest);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function deriveRoomKey(frequency: string): Promise<CryptoKey> {
  // Shared-secret model: knowledge of `frequency` => can derive key.
  // For simplicity, use SHA-256(frequency) as raw key material.
  const keyBytes = await sha256Bytes(`open-radio/v1:${frequency}`);
  // Cast avoids TS lib.dom ArrayBufferLike friction in some toolchains.
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt'
  ]);
}

export async function roomHash(frequency: string): Promise<string> {
  // Hash sent to signaling server to avoid leaking the plain frequency string.
  const h = await sha256Bytes(`open-radio/room-hash/v1:${frequency}`);
  return bytesToHex(h);
}

export async function encryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as unknown as BufferSource,
      additionalData: (aad as unknown as BufferSource | undefined) ?? undefined
    },
    key,
    plaintext as unknown as BufferSource
  );
  const out = new Uint8Array(iv.byteLength + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.byteLength);
  return out;
}

export async function decryptBytes(
  key: CryptoKey,
  ciphertext: Uint8Array,
  aad?: Uint8Array
): Promise<Uint8Array> {
  if (ciphertext.byteLength < 13) throw new Error('ciphertext too short');
  const iv = ciphertext.slice(0, 12);
  const body = ciphertext.slice(12);
  const pt = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv as unknown as BufferSource,
      additionalData: (aad as unknown as BufferSource | undefined) ?? undefined
    },
    key,
    body as unknown as BufferSource
  );
  return new Uint8Array(pt);
}

export async function encryptJson(key: CryptoKey, obj: unknown, aad?: Uint8Array) {
  const enc = new TextEncoder();
  return encryptBytes(key, enc.encode(JSON.stringify(obj)), aad);
}

export async function decryptJson<T>(
  key: CryptoKey,
  bytes: Uint8Array,
  aad?: Uint8Array
): Promise<T> {
  const dec = new TextDecoder();
  const pt = await decryptBytes(key, bytes, aad);
  return JSON.parse(dec.decode(pt)) as T;
}

