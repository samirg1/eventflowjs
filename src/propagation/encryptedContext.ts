import type { EventContext } from "../types.js";

const ENCRYPTED_VALUE_PREFIX = "enc:v1";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const SHA256_INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encryptContextForPropagation(
  context: EventContext,
  encryptionKey?: string,
): EventContext {
  const entries = Object.entries(context);
  if (entries.length === 0) {
    return {};
  }

  if (!encryptionKey) {
    throw new TypeError(
      "EventFlow encrypted context requires configure({ encryptionKey }) with the shared key.",
    );
  }

  const key = deriveKey(encryptionKey);
  const next: EventContext = {};

  for (const [field, value] of entries) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      continue;
    }

    next[field] = encryptSerializedValue(serialized, key);
  }

  return next;
}

export function decryptContextFromPropagation(
  raw: unknown,
  encryptionKey?: string,
): EventContext {
  if (!isRecord(raw)) {
    return {};
  }

  const key = encryptionKey ? deriveKey(encryptionKey) : undefined;
  const next: EventContext = {};

  for (const [field, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.startsWith(ENCRYPTED_VALUE_PREFIX)) {
      if (!key) {
        throw new TypeError(
          "EventFlow encrypted context requires configure({ encryptionKey }) with the shared key.",
        );
      }

      next[field] = decryptSerializedValue(value, key);
      continue;
    }

    next[field] = value;
  }

  return next;
}

function encryptSerializedValue(value: string, key: Uint8Array): string {
  const iv = randomBytes(IV_LENGTH);
  const plaintext = encoder.encode(value);
  const keystream = expandKeystream(key, iv, plaintext.length);
  const ciphertext = xorBytes(plaintext, keystream);
  const tag = hmacSha256(key, concatBytes(iv, ciphertext)).subarray(0, TAG_LENGTH);

  return [
    ENCRYPTED_VALUE_PREFIX,
    encodeBase64Url(iv),
    encodeBase64Url(ciphertext),
    encodeBase64Url(tag),
  ].join(".");
}

function decryptSerializedValue(payload: string, key: Uint8Array): unknown {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== ENCRYPTED_VALUE_PREFIX) {
    throw new TypeError(
      "EventFlow encrypted context could not be decrypted. Check that all services share the same encryptionKey.",
    );
  }

  const iv = decodeBase64Url(parts[1]);
  const ciphertext = decodeBase64Url(parts[2]);
  const tag = decodeBase64Url(parts[3]);
  const expectedTag = hmacSha256(key, concatBytes(iv, ciphertext)).subarray(0, TAG_LENGTH);

  if (
    iv.length !== IV_LENGTH ||
    tag.length !== TAG_LENGTH ||
    !constantTimeEqual(tag, expectedTag)
  ) {
    throw new TypeError(
      "EventFlow encrypted context could not be decrypted. Check that all services share the same encryptionKey.",
    );
  }

  const keystream = expandKeystream(key, iv, ciphertext.length);
  const plaintext = xorBytes(ciphertext, keystream);

  try {
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new TypeError(
      "EventFlow encrypted context could not be decrypted. Check that all services share the same encryptionKey.",
    );
  }
}

function deriveKey(encryptionKey: string): Uint8Array {
  return sha256(encoder.encode(encryptionKey));
}

function expandKeystream(key: Uint8Array, iv: Uint8Array, length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  let counter = 0;

  while (offset < length) {
    const counterBytes = new Uint8Array(4);
    const counterView = new DataView(counterBytes.buffer);
    counterView.setUint32(0, counter++);

    const block = hmacSha256(key, concatBytes(iv, counterBytes));
    const remaining = Math.min(block.length, length - offset);
    output.set(block.subarray(0, remaining), offset);
    offset += remaining;
  }

  return output;
}

function xorBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length);
  for (let index = 0; index < left.length; index += 1) {
    output[index] = left[index] ^ right[index];
  }

  return output;
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const blockSize = 64;
  const normalizedKey = key.length > blockSize ? sha256(key) : key;
  const keyBlock = new Uint8Array(blockSize);
  keyBlock.set(normalizedKey);

  const innerPad = new Uint8Array(blockSize);
  const outerPad = new Uint8Array(blockSize);

  for (let index = 0; index < blockSize; index += 1) {
    innerPad[index] = keyBlock[index] ^ 0x36;
    outerPad[index] = keyBlock[index] ^ 0x5c;
  }

  return sha256(concatBytes(outerPad, sha256(concatBytes(innerPad, data))));
}

function sha256(message: Uint8Array): Uint8Array {
  const bitLength = message.length * 8;
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  const view = new DataView(padded.buffer);
  const words = new Uint32Array(64);
  const hash = new Uint32Array(SHA256_INITIAL);

  padded.set(message);
  padded[message.length] = 0x80;
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  for (let chunkOffset = 0; chunkOffset < padded.length; chunkOffset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(chunkOffset + index * 4);
    }

    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotateRight(words[index - 15], 7) ^
        rotateRight(words[index - 15], 18) ^
        (words[index - 15] >>> 3);
      const s1 =
        rotateRight(words[index - 2], 17) ^
        rotateRight(words[index - 2], 19) ^
        (words[index - 2] >>> 10);
      words[index] =
        (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  for (let index = 0; index < hash.length; index += 1) {
    outputView.setUint32(index * 4, hash[index]);
  }

  return output;
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }

  return diff === 0;
}

function randomBytes(length: number): Uint8Array {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject?.getRandomValues) {
    throw new TypeError("EventFlow encrypted context requires crypto.getRandomValues().");
  }

  return cryptoObject.getRandomValues(new Uint8Array(length));
}

function encodeBase64Url(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64url");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return Uint8Array.from(Buffer.from(value, "base64url"));
  }

  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }

  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
