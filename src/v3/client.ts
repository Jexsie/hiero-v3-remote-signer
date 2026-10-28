// Facade for the V3 `consensusnode.client` namespace
// (spec/consensus-node-client/client.md). Deviations from the spec are marked
// with the finding they belong to, see FINDINGS.md.

import { Client as V2Client } from "@hiero-ledger/sdk";

import type { PrivateKey, PublicKey } from "./keys.js";
import { AccountId } from "./ledger.js";
import type { NetworkSetting } from "./ledger.js";

/**
 * A serialized TransactionBody for one target consensus node: the exact bytes
 * a signer must sign. Defined in `consensusnode.transactions` in the spec;
 * declared here because the signer takes it as input (F4).
 */
export interface NodeBody {
    readonly node: AccountId;
    readonly bytes: Uint8Array;
}

/** One key's signature over the body addressed to one node. */
export interface NodeSignature {
    readonly node: AccountId;
    readonly publicKey: PublicKey;
    readonly signature: Uint8Array;
}

/**
 * Signs transaction bodies with a key the SDK does not hold, for example in a
 * KMS or an HSM.
 *
 * Spec: `NodeSignature signTransaction(transactionBytes: bytes, node: AccountId)`.
 * - F1: async, because remote signing is I/O.
 * - F2: exposes the public key, which every NodeSignature carries and which
 *   callers need to build account keys.
 * - F4: takes a NodeBody, so it is unambiguous which bytes are signed.
 * - F5: receives the raw body bytes; applying the algorithm's digest
 *   (Keccak-256 for ECDSA secp256k1) is the signer's job.
 */
export interface TransactionSigner {
    readonly publicKey: PublicKey;
    signTransaction(body: NodeBody): Promise<NodeSignature>;
}

/** A TransactionSigner over an in-memory PrivateKey: the default, local case. */
export class PrivateKeySigner implements TransactionSigner {
    readonly publicKey: PublicKey;
    readonly #privateKey: PrivateKey;

    constructor(privateKey: PrivateKey) {
        this.#privateKey = privateKey;
        this.publicKey = privateKey.createPublicKey();
    }

    async signTransaction(body: NodeBody): Promise<NodeSignature> {
        return {
            node: body.node,
            publicKey: this.publicKey,
            signature: this.#privateKey.sign(body.bytes),
        };
    }
}

/**
 * An account that signs and pays for requests.
 *
 * Spec: `Account { accountId, privateKey }`. F3: holds a TransactionSigner
 * instead, so an account whose key lives in a KMS is still an Account. A local
 * key is one kind of signer, see `Account.ofPrivateKey`.
 */
export class Account {
    readonly accountId: AccountId;
    readonly signer: TransactionSigner;

    constructor(accountId: AccountId, signer: TransactionSigner) {
        this.accountId = accountId;
        this.signer = signer;
    }

    static ofPrivateKey(accountId: AccountId, privateKey: PrivateKey): Account {
        return new Account(accountId, new PrivateKeySigner(privateKey));
    }
}

/** Facade-only options, see F7. */
export interface ClientOptions {
    /**
     * How many consensus nodes `selectNodes()` returns. Every target node
     * costs one signature per key, so with remote signers this is the number
     * of backend calls per key and transaction. Defaults to 3.
     */
    readonly nodesPerTransaction?: number;
}

/**
 * A connection to one network with one operator account.
 *
 * Spec: `HieroClient { operatorAccount, network, transactionSigner }`. F3: the
 * separate `transactionSigner` is gone, the operator Account carries it.
 */
export class HieroClient {
    readonly operatorAccount: Account;
    readonly network: NetworkSetting;
    readonly nodesPerTransaction: number;
    /**
     * @internal The V2 client that does the gRPC work. It has no operator, so
     * V2 never signs implicitly: every signature comes through the V3 API.
     */
    readonly _v2: V2Client;

    constructor(
        network: NetworkSetting,
        operatorAccount: Account,
        options: ClientOptions = {},
    ) {
        this.network = network;
        this.operatorAccount = operatorAccount;
        this.nodesPerTransaction = options.nodesPerTransaction ?? 3;
        this._v2 = V2Client.forNetwork(
            Object.fromEntries(
                network.consensusNodes.map((n) => [
                    n.address,
                    n.account.toString(),
                ]),
            ),
        );
    }

    /**
     * Picks target nodes for `Transaction.pack`. Not in the spec (F7): the spec
     * makes callers pass `nodes` but gives them no way to obtain them.
     */
    selectNodes(count = this.nodesPerTransaction): AccountId[] {
        const unique = new Map<string, AccountId>();
        for (const node of this.network.consensusNodes) {
            unique.set(node.account.toString(), node.account);
        }
        const all = [...unique.values()];
        for (let i = all.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [all[i], all[j]] = [all[j]!, all[i]!];
        }
        return all.slice(0, Math.max(1, count));
    }

    close(): void {
        this._v2.close();
    }
}

export function createClient(
    networkSettings: NetworkSetting,
    operatorAccount: Account,
    options?: ClientOptions,
): HieroClient {
    return new HieroClient(networkSettings, operatorAccount, options);
}
