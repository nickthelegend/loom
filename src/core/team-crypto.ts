/**
 * Loom Teams — the cryptography, all of it in one small file.
 *
 * Decisions this implements (docs/teams-architecture.md §1a):
 *   D2  content is end-to-end encrypted to the team; metadata stays plain
 *   D5  the team key rides the invite link's #fragment
 *   D6  leaving rotates the key forward, sealed to each remaining device
 *
 * Primitives, all audited pure-JS (@noble/*), so the phone runs the same code:
 *   - team key: 32 random bytes, versioned; content is XChaCha20-Poly1305
 *     (the relay's seal/open), bound to the team + key version as AAD-by-prefix
 *   - device keys: X25519 (sealing) + Ed25519 (signing), generated per device
 *   - sealed box: ephemeral X25519 → HKDF-SHA256 → XChaCha20-Poly1305, so a
 *     new team key can be handed to a device knowing only its public key
 *   - signatures: Ed25519 over the canonical JSON of what a daemon publishes
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { fromB64, toB64 } from "./relay-protocol.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// Team key and sealed content
// ---------------------------------------------------------------------------

export interface TeamKey {
  version: number;
  key: string; // base64url, 32 bytes
}

export function newTeamKey(version = 1): TeamKey {
  return { version, key: toB64(randomBytes(32)) };
}

/** A sealed value as stored on the hub: which key version, and the ciphertext. */
export interface Sealed {
  v: number; // team key version
  c: string; // base64url nonce‖ciphertext
}

/** Encrypt any JSON value to the team. The hub stores this and can't read it. */
export function sealForTeam(key: TeamKey, value: unknown): Sealed {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(fromB64(key.key), nonce).encrypt(enc.encode(JSON.stringify(value)));
  const out = new Uint8Array(24 + ct.length);
  out.set(nonce, 0);
  out.set(ct, 24);
  return { v: key.version, c: toB64(out) };
}

/** Decrypt with whichever key version sealed it; null if unknown or tampered. */
export function openFromTeam<T = unknown>(keys: TeamKey[], sealed: Sealed | null | undefined): T | null {
  if (!sealed || typeof sealed.c !== "string") return null;
  const key = keys.find((k) => k.version === sealed.v);
  if (!key) return null;
  try {
    const raw = fromB64(sealed.c);
    if (raw.length < 24 + 16) return null;
    const pt = xchacha20poly1305(fromB64(key.key), raw.slice(0, 24)).decrypt(raw.slice(24));
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Device keys and sealed boxes (key rotation, D6)
// ---------------------------------------------------------------------------

export interface DeviceKeys {
  /** X25519 — others seal team keys to this. */
  sealPub: string;
  sealPriv: string;
  /** Ed25519 — this device signs what it publishes. */
  signPub: string;
  signPriv: string;
}

export function newDeviceKeys(): DeviceKeys {
  const sealPriv = x25519.utils.randomSecretKey();
  const signPriv = ed25519.utils.randomSecretKey();
  return {
    sealPub: toB64(x25519.getPublicKey(sealPriv)),
    sealPriv: toB64(sealPriv),
    signPub: toB64(ed25519.getPublicKey(signPriv)),
    signPriv: toB64(signPriv),
  };
}

const SEAL_INFO = enc.encode("loom-team-seal-v1");

/** Seal bytes to a device's X25519 public key. Only that device can open it. */
export function sealTo(recipientSealPub: string, plaintext: Uint8Array): string {
  const eph = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(eph);
  const rpub = fromB64(recipientSealPub);
  const shared = x25519.getSharedSecret(eph, rpub);
  const salt = new Uint8Array(64);
  salt.set(ephPub, 0);
  salt.set(rpub, 32);
  const k = hkdf(sha256, shared, salt, SEAL_INFO, 32);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(k, nonce).encrypt(plaintext);
  const out = new Uint8Array(32 + 24 + ct.length);
  out.set(ephPub, 0);
  out.set(nonce, 32);
  out.set(ct, 56);
  return toB64(out);
}

export function openSealed(device: Pick<DeviceKeys, "sealPriv" | "sealPub">, box: string): Uint8Array | null {
  try {
    const raw = fromB64(box);
    if (raw.length < 32 + 24 + 16) return null;
    const ephPub = raw.slice(0, 32);
    const mine = fromB64(device.sealPub);
    const shared = x25519.getSharedSecret(fromB64(device.sealPriv), ephPub);
    const salt = new Uint8Array(64);
    salt.set(ephPub, 0);
    salt.set(mine, 32);
    const k = hkdf(sha256, shared, salt, SEAL_INFO, 32);
    return xchacha20poly1305(k, raw.slice(32, 56)).decrypt(raw.slice(56));
  } catch {
    return null;
  }
}

/** Seal a team key to a device — the envelope the hub stores per device. */
export function sealTeamKey(recipientSealPub: string, key: TeamKey): string {
  return sealTo(recipientSealPub, enc.encode(JSON.stringify(key)));
}

export function openTeamKey(device: Pick<DeviceKeys, "sealPriv" | "sealPub">, envelope: string): TeamKey | null {
  const pt = openSealed(device, envelope);
  if (!pt) return null;
  try {
    const k = JSON.parse(dec.decode(pt)) as TeamKey;
    return typeof k.key === "string" && Number.isInteger(k.version) ? k : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/** Deterministic JSON: sorted keys, so signer and verifier hash the same bytes. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function signPayload(device: Pick<DeviceKeys, "signPriv">, payload: unknown): string {
  return toB64(ed25519.sign(enc.encode(canonicalJson(payload)), fromB64(device.signPriv)));
}

export function verifyPayload(signPub: string, payload: unknown, sig: string): boolean {
  try {
    return ed25519.verify(fromB64(sig), enc.encode(canonicalJson(payload)), fromB64(signPub));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Invites (D5)
// ---------------------------------------------------------------------------

/** What an invite link's #fragment carries: the invite token and the team key. */
export interface InviteFragment {
  invite: string;
  key: TeamKey;
  hub: string;
}

export function packInvite(f: InviteFragment): string {
  return toB64(enc.encode(JSON.stringify(f)));
}

export function unpackInvite(s: string): InviteFragment | null {
  try {
    const f = JSON.parse(dec.decode(fromB64(s))) as InviteFragment;
    return typeof f.invite === "string" && f.key && typeof f.key.key === "string" && typeof f.hub === "string" ? f : null;
  } catch {
    return null;
  }
}
