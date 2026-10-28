// Ported from hiero-remote-signer (src/aws/AwsKmsSigner.ts). The KMS handling
// is unchanged; the class now implements the V3 TransactionSigner instead of
// the V2 `signWith` callback.

import {
    GetPublicKeyCommand,
    KMSClient,
    SignCommand,
} from "@aws-sdk/client-kms";
import type {
    KMSClientConfig,
    SigningAlgorithmSpec,
} from "@aws-sdk/client-kms";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { derSignatureToCompact, parseSpki } from "../../der/index.js";
import {
    RemoteSignerError,
    RemoteSignerErrorCodes,
} from "../../errors/index.js";
import { PublicKey } from "../../v3/index.js";
import type {
    KeyAlgorithm,
    NodeBody,
    NodeSignature,
    TransactionSigner,
} from "../../v3/index.js";

/** AWS KMS signs at most 4096 bytes with `MessageType: RAW`, which Ed25519 requires. */
export const AWS_KMS_MAX_RAW_MESSAGE_BYTES = 4096;

const KEY_SPECS: Record<
    string,
    { algorithm: KeyAlgorithm; signing: SigningAlgorithmSpec }
> = {
    ECC_SECG_P256K1: { algorithm: "ECDSA_SECP256K1", signing: "ECDSA_SHA_256" },
    ECC_NIST_EDWARDS25519: { algorithm: "ED25519", signing: "ED25519_SHA_512" },
};

export interface AwsKmsSignerOptions {
    /** Key ID, key ARN, alias name (`alias/...`) or alias ARN. */
    keyId: string;
    /** An existing KMS client; otherwise one is created from `clientConfig`. */
    client?: KMSClient;
    clientConfig?: KMSClientConfig;
    /** Verify every signature locally before returning it. Defaults to `true`. */
    verifySignatures?: boolean;
    grantTokens?: string[];
}

/**
 * A TransactionSigner backed by an asymmetric AWS KMS key
 * (`ECC_SECG_P256K1` or `ECC_NIST_EDWARDS25519`). The private key never
 * leaves KMS; each `signTransaction` is one KMS `Sign` call.
 */
export class AwsKmsSigner implements TransactionSigner {
    readonly publicKey: PublicKey;
    /** The key ARN as reported by KMS, resolved from any alias. */
    readonly keyArn: string;

    readonly #client: KMSClient;
    readonly #signing: SigningAlgorithmSpec;
    readonly #verify: boolean;
    readonly #grantTokens: string[] | undefined;

    private constructor(params: {
        client: KMSClient;
        keyArn: string;
        signing: SigningAlgorithmSpec;
        publicKey: PublicKey;
        verify: boolean;
        grantTokens: string[] | undefined;
    }) {
        this.#client = params.client;
        this.keyArn = params.keyArn;
        this.#signing = params.signing;
        this.publicKey = params.publicKey;
        this.#verify = params.verify;
        this.#grantTokens = params.grantTokens;
    }

    /** Fetches the public key for `keyId` and validates that it can sign for Hiero. */
    static async create(options: AwsKmsSignerOptions): Promise<AwsKmsSigner> {
        const client =
            options.client ?? new KMSClient(options.clientConfig ?? {});

        let response;
        try {
            response = await client.send(
                new GetPublicKeyCommand({
                    KeyId: options.keyId,
                    GrantTokens: options.grantTokens,
                }),
            );
        } catch (cause) {
            throw new RemoteSignerError(
                RemoteSignerErrorCodes.BackendRequestFailed,
                `GetPublicKey failed for ${options.keyId}`,
                { cause },
            );
        }

        const spec = response.KeySpec ? KEY_SPECS[response.KeySpec] : undefined;
        if (!spec) {
            throw new RemoteSignerError(
                RemoteSignerErrorCodes.UnsupportedKey,
                `KMS key spec ${response.KeySpec ?? "unknown"} is not supported; ` +
                    `use ECC_SECG_P256K1 or ECC_NIST_EDWARDS25519`,
            );
        }
        if (response.KeyUsage !== "SIGN_VERIFY") {
            throw new RemoteSignerError(
                RemoteSignerErrorCodes.KeyNotUsable,
                `KMS key usage is ${response.KeyUsage ?? "unknown"}; SIGN_VERIFY is required`,
            );
        }
        if (
            response.SigningAlgorithms &&
            !response.SigningAlgorithms.includes(spec.signing)
        ) {
            throw new RemoteSignerError(
                RemoteSignerErrorCodes.KeyNotUsable,
                `KMS key does not offer signing algorithm ${spec.signing}`,
            );
        }
        if (!response.PublicKey) {
            throw new RemoteSignerError(
                RemoteSignerErrorCodes.MalformedDer,
                "GetPublicKey returned no public key",
            );
        }

        const parsed = parseSpki(response.PublicKey);
        if (parsed.keyType !== spec.algorithm) {
            throw new RemoteSignerError(
                RemoteSignerErrorCodes.UnsupportedKey,
                `KMS reported ${response.KeySpec} but returned a ${parsed.keyType} public key`,
            );
        }

        return new AwsKmsSigner({
            client,
            keyArn: response.KeyId ?? options.keyId,
            signing: spec.signing,
            publicKey: PublicKey.fromRawBytes(parsed.keyType, parsed.publicKey),
            verify: options.verifySignatures ?? true,
            grantTokens: options.grantTokens,
        });
    }

    async signTransaction(body: NodeBody): Promise<NodeSignature> {
        return {
            node: body.node,
            publicKey: this.publicKey,
            signature: await this.#sign(body.bytes),
        };
    }

    /**
     * For ECDSA keys the body is hashed locally with Keccak-256, the digest
     * Hiero verifies, and KMS signs that digest (`MessageType: DIGEST`); KMS
     * has no Keccak. For Ed25519 keys KMS signs the raw bytes.
     */
    async #sign(bodyBytes: Uint8Array): Promise<Uint8Array> {
        const ecdsa = this.publicKey.algorithm === "ECDSA_SECP256K1";
        if (!ecdsa && bodyBytes.length > AWS_KMS_MAX_RAW_MESSAGE_BYTES) {
            throw new RemoteSignerError(
                RemoteSignerErrorCodes.MessageRejected,
                `transaction body is ${bodyBytes.length} bytes; AWS KMS signs at most ` +
                    `${AWS_KMS_MAX_RAW_MESSAGE_BYTES} bytes with Ed25519`,
            );
        }

        let response;
        try {
            response = await this.#client.send(
                new SignCommand({
                    KeyId: this.keyArn,
                    Message: ecdsa ? keccak_256(bodyBytes) : bodyBytes,
                    MessageType: ecdsa ? "DIGEST" : "RAW",
                    SigningAlgorithm: this.#signing,
                    GrantTokens: this.#grantTokens,
                }),
            );
        } catch (cause) {
            throw new RemoteSignerError(
                RemoteSignerErrorCodes.BackendRequestFailed,
                `Sign failed for ${this.keyArn}`,
                { cause },
            );
        }
        if (!response.Signature) {
            throw new RemoteSignerError(
                RemoteSignerErrorCodes.SignatureInvalid,
                "KMS returned no signature",
            );
        }

        const signature = ecdsa
            ? derSignatureToCompact(response.Signature)
            : new Uint8Array(response.Signature);
        if (signature.length !== 64) {
            throw new RemoteSignerError(
                RemoteSignerErrorCodes.SignatureInvalid,
                `expected a 64-byte signature, got ${signature.length} bytes`,
            );
        }
        if (this.#verify && !this.publicKey.verify(bodyBytes, signature)) {
            throw new RemoteSignerError(
                RemoteSignerErrorCodes.SignatureInvalid,
                "KMS signature does not verify against the key's public key",
            );
        }
        return signature;
    }
}
