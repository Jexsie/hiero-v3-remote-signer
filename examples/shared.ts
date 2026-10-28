import { AwsKmsSigner } from "../src/signers/aws/index.js";
import { VaultTransitSigner } from "../src/signers/vault/index.js";
import {
    Account,
    AccountId,
    getNetworkSetting,
    PrivateKey,
} from "../src/v3/index.js";
import type {
    KeyAlgorithm,
    NodeBody,
    NodeSignature,
    TransactionSigner,
} from "../src/v3/index.js";

export function env(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set; see .env.example`);
    return value;
}

export const network = () =>
    getNetworkSetting(process.env.NETWORK ?? "hedera-testnet");

/** The account that funds setup and coordinates the multi-party example. Local key. */
export function fundingAccount(): Account {
    return Account.ofPrivateKey(
        AccountId.fromString(env("FUNDING_ACCOUNT_ID")),
        PrivateKey.fromString(
            (process.env.FUNDING_KEY_ALGORITHM ??
                "ECDSA_SECP256K1") as KeyAlgorithm,
            env("FUNDING_PRIVATE_KEY"),
        ),
    );
}

export const kmsSigner = () =>
    AwsKmsSigner.create({ keyId: env("AWS_KMS_KEY_ID") });

export const vaultSigner = () =>
    VaultTransitSigner.create({
        address: env("VAULT_ADDR"),
        token: env("VAULT_TOKEN"),
        keyName: env("VAULT_KEY_NAME"),
    });

/** Logs every backend call, to make the per-node signing cost visible (F7). */
export function logged(
    name: string,
    signer: TransactionSigner,
): TransactionSigner {
    return {
        publicKey: signer.publicKey,
        async signTransaction(body: NodeBody): Promise<NodeSignature> {
            const started = performance.now();
            const signature = await signer.signTransaction(body);
            console.log(
                `  ${name}: signed body for node ${body.node.toString()} ` +
                    `(${Math.round(performance.now() - started)} ms)`,
            );
            return signature;
        },
    };
}
