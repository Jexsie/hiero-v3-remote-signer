// Facade for the V3 `keys` namespace (spec/base/keys.md). Only the parts the
// signing flows touch are modelled. Each type wraps its V2 counterpart, which
// does the actual cryptography.

import {
    PrivateKey as V2PrivateKey,
    PublicKey as V2PublicKey,
} from "@hiero-ledger/sdk";

/** Key algorithms that Hiero consensus nodes verify. */
export type KeyAlgorithm = "ED25519" | "ECDSA_SECP256K1";

/**
 * A public key. `verify` follows Hiero's rules: Ed25519 over the raw message,
 * ECDSA secp256k1 over the Keccak-256 digest of the message.
 */
export class PublicKey {
    readonly algorithm: KeyAlgorithm;
    /** @internal The wrapped V2 key. Not part of the V3 surface. */
    readonly _v2: V2PublicKey;

    private constructor(algorithm: KeyAlgorithm, v2: V2PublicKey) {
        this.algorithm = algorithm;
        this._v2 = v2;
    }

    /** Raw key bytes: 32 bytes for Ed25519, 33-byte compressed point for secp256k1. */
    static fromRawBytes(algorithm: KeyAlgorithm, bytes: Uint8Array): PublicKey {
        return new PublicKey(
            algorithm,
            algorithm === "ED25519"
                ? V2PublicKey.fromBytesED25519(bytes)
                : V2PublicKey.fromBytesECDSA(bytes),
        );
    }

    /** @internal */
    static _fromV2(v2: V2PublicKey): PublicKey {
        return new PublicKey(
            v2.type === "secp256k1" ? "ECDSA_SECP256K1" : "ED25519",
            v2,
        );
    }

    get rawBytes(): Uint8Array {
        return this._v2.toBytesRaw();
    }

    verify(message: Uint8Array, signature: Uint8Array): boolean {
        return this._v2.verify(message, signature);
    }

    equals(other: PublicKey): boolean {
        return this._v2.equals(other._v2);
    }

    toString(): string {
        return this._v2.toStringRaw();
    }
}

/** A private key held in process memory. */
export class PrivateKey {
    readonly algorithm: KeyAlgorithm;
    readonly #v2: V2PrivateKey;

    private constructor(algorithm: KeyAlgorithm, v2: V2PrivateKey) {
        this.algorithm = algorithm;
        this.#v2 = v2;
    }

    static generate(algorithm: KeyAlgorithm): PrivateKey {
        return new PrivateKey(
            algorithm,
            algorithm === "ED25519"
                ? V2PrivateKey.generateED25519()
                : V2PrivateKey.generateECDSA(),
        );
    }

    /** Parses a DER- or raw-hex-encoded key, as printed by the portal and the V2 SDK. */
    static fromString(algorithm: KeyAlgorithm, value: string): PrivateKey {
        return new PrivateKey(
            algorithm,
            algorithm === "ED25519"
                ? V2PrivateKey.fromStringED25519(value)
                : V2PrivateKey.fromStringECDSA(value),
        );
    }

    sign(message: Uint8Array): Uint8Array {
        return this.#v2.sign(message);
    }

    createPublicKey(): PublicKey {
        return PublicKey._fromV2(this.#v2.publicKey);
    }
}
