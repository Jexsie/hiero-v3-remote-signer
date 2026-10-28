// Facade for the V3 `consensusnode.transactions` namespace
// (spec/consensus-node-client/transactions.md): Transaction -> pack ->
// PackedTransaction -> sign -> submit -> Response. The V2 SDK builds the
// protobuf bodies and talks gRPC; every signature goes through this API.

import {
    Hbar,
    ReceiptStatusError,
    SignatureMap,
    Transaction as V2Transaction,
    TransactionId as V2TransactionId,
} from "@hiero-ledger/sdk";
import type {
    TransactionReceipt as V2TransactionReceipt,
    TransactionResponse as V2TransactionResponse,
} from "@hiero-ledger/sdk";

import type {
    Account,
    HieroClient,
    NodeBody,
    NodeSignature,
    TransactionSigner,
} from "./client.js";
import { SdkError } from "./errors.js";
import { PublicKey } from "./keys.js";
import { AccountId, TransactionId } from "./ledger.js";

/** Status code reported by the network. An open set, so not an enum. */
export interface TransactionStatus {
    readonly code: number;
    readonly name: string;
}

export interface Receipt {
    readonly transactionId: TransactionId;
    readonly status: TransactionStatus;
}

export class Response<R extends Receipt = Receipt> {
    readonly transactionId: TransactionId;
    readonly #v2: V2TransactionResponse;
    readonly #client: HieroClient;

    /** @internal */
    constructor(v2: V2TransactionResponse, client: HieroClient) {
        this.#v2 = v2;
        this.#client = client;
        this.transactionId = TransactionId._fromV2(v2.transactionId);
    }

    /** Waits for consensus and returns the receipt, whatever its status. */
    async queryReceipt(): Promise<R> {
        let receipt: V2TransactionReceipt;
        try {
            receipt = await this.#v2.getReceipt(this.#client._v2);
        } catch (error) {
            if (!(error instanceof ReceiptStatusError)) throw error;
            receipt = error.transactionReceipt;
        }
        return {
            transactionId: this.transactionId,
            status: {
                code: receipt.status._code,
                name: receipt.status.toString(),
            },
        } as R;
    }
}

/** The editable form of a transaction. */
export abstract class Transaction<R extends Receipt = Receipt> {
    /** Maximum fee the payer accepts, in tinybars. */
    maxTransactionFee?: bigint;
    validDurationSeconds?: number;
    memo?: string;

    /** @internal Builds the unfrozen V2 transaction with the service-specific fields. */
    protected abstract _buildV2(): V2Transaction;

    /**
     * Binds the transaction to a payer, target nodes and a fresh TransactionId.
     * The result has no signatures.
     */
    pack(payer: Account, nodes: readonly AccountId[]): PackedTransaction<R> {
        if (nodes.length === 0) {
            throw new Error("pack needs at least one target node");
        }
        const v2 = this._buildV2()
            .setTransactionId(V2TransactionId.generate(payer.accountId._toV2()))
            .setNodeAccountIds(nodes.map((n) => n._toV2()));
        if (this.maxTransactionFee !== undefined) {
            v2.setMaxTransactionFee(
                Hbar.fromTinybars(this.maxTransactionFee.toString()),
            );
        }
        if (this.validDurationSeconds !== undefined) {
            v2.setTransactionValidDuration(this.validDurationSeconds);
        }
        if (this.memo !== undefined) {
            v2.setTransactionMemo(this.memo);
        }
        return PackedTransaction._wrap<R>(v2.freeze());
    }

    /** Packs with `payer` and signs with the payer's signer (F6: async). */
    sign(
        payer: Account,
        nodes: readonly AccountId[],
    ): Promise<PackedTransaction<R>> {
        return this.pack(payer, nodes).sign(payer.signer);
    }

    /** Packs with the operator as payer, for `client.selectNodes()`, and signs (F6: async). */
    signWithOperator(client: HieroClient): Promise<PackedTransaction<R>> {
        return this.sign(client.operatorAccount, client.selectNodes());
    }

    async signWithOperatorAndSubmit(client: HieroClient): Promise<Response<R>> {
        return (await this.signWithOperator(client)).submit(client);
    }
}

/**
 * The byte-stable form of a transaction, ready for signatures and the wire.
 * Immutable: `sign` returns a new instance.
 */
export class PackedTransaction<R extends Receipt = Receipt> {
    readonly #v2: V2Transaction;

    private constructor(v2: V2Transaction) {
        this.#v2 = v2;
    }

    /** @internal */
    static _wrap<R extends Receipt>(v2: V2Transaction): PackedTransaction<R> {
        return new PackedTransaction<R>(v2);
    }

    static fromBytes<R extends Receipt = Receipt>(
        bytes: Uint8Array,
    ): PackedTransaction<R> {
        const v2 = V2Transaction.fromBytes(bytes);
        if (!v2.isFrozen() || v2.transactionId == null) {
            throw new Error("bytes do not hold a packed transaction");
        }
        return new PackedTransaction<R>(v2);
    }

    get transactionId(): TransactionId {
        return TransactionId._fromV2(this.#v2.transactionId!);
    }

    /** The target nodes, one body each. Not in the spec, which keeps them implicit. */
    get nodes(): AccountId[] {
        return (this.#v2.nodeAccountIds ?? []).map(AccountId._fromV2);
    }

    get nodeSignatures(): NodeSignature[] {
        const result: NodeSignature[] = [];
        for (const [node, byTransaction] of this.#v2.getSignatures()) {
            for (const [, byKey] of byTransaction) {
                for (const [publicKey, signature] of byKey) {
                    result.push({
                        node: AccountId._fromV2(node),
                        publicKey: PublicKey._fromV2(publicKey),
                        signature,
                    });
                }
            }
        }
        return result;
    }

    /** The exact bytes each target node's signature must cover. */
    signableBodies(): NodeBody[] {
        return this.#v2.signableNodeBodyBytesList.map((entry) => ({
            node: AccountId._fromV2(entry.nodeAccountId),
            bytes: entry.signableTransactionBodyBytes,
        }));
    }

    /**
     * Adds signatures. With an Account or a TransactionSigner, one signature
     * per target node is requested from the signer, so the call is async (F6).
     * With a list of NodeSignatures, produced out of process, it is not.
     */
    sign(signatures: readonly NodeSignature[]): PackedTransaction<R>;
    sign(signer: Account | TransactionSigner): Promise<PackedTransaction<R>>;
    sign(
        arg: readonly NodeSignature[] | Account | TransactionSigner,
    ): PackedTransaction<R> | Promise<PackedTransaction<R>> {
        if (Array.isArray(arg))
            return this.#attach(arg as readonly NodeSignature[]);
        const signer = "signTransaction" in arg ? arg : (arg as Account).signer;
        return this.#signWith(signer);
    }

    async #signWith(signer: TransactionSigner): Promise<PackedTransaction<R>> {
        const signatures = await Promise.all(
            this.signableBodies().map((body) => signer.signTransaction(body)),
        );
        return this.#attach(signatures);
    }

    #attach(signatures: readonly NodeSignature[]): PackedTransaction<R> {
        const bodies = new Map(
            this.signableBodies().map((b) => [b.node.toString(), b]),
        );
        const byKey = new Map<string, NodeSignature[]>();
        for (const s of signatures) {
            const body = bodies.get(s.node.toString());
            if (!body) {
                throw new SdkError(
                    "unknown-node-error",
                    `node ${s.node.toString()} is not a target of this transaction`,
                );
            }
            if (!s.publicKey.verify(body.bytes, s.signature)) {
                throw new SdkError(
                    "invalid-signature-error",
                    `signature of ${s.publicKey.toString()} for node ${s.node.toString()} does not verify`,
                );
            }
            const key = s.publicKey.toString();
            byKey.set(key, [...(byKey.get(key) ?? []), s]);
        }

        const v2 = V2Transaction.fromBytes(this.#v2.toBytes());
        const txId = this.#v2.transactionId!;
        for (const group of byKey.values()) {
            const covered = new Set(group.map((s) => s.node.toString()));
            const missing = [...bodies.keys()].filter((n) => !covered.has(n));
            if (missing.length > 0) {
                throw new SdkError(
                    "incomplete-signatures-error",
                    `key ${group[0]!.publicKey.toString()} has no signature for node(s) ${missing.join(", ")}`,
                );
            }
            const map = new SignatureMap();
            for (const s of group) {
                map.addSignature(
                    s.node._toV2(),
                    txId,
                    s.publicKey._v2,
                    s.signature,
                );
            }
            v2.addSignature(group[0]!.publicKey._v2, map);
        }
        return new PackedTransaction<R>(v2);
    }

    toBytes(): Uint8Array {
        return this.#v2.toBytes();
    }

    async submit(client: HieroClient): Promise<Response<R>> {
        // execute() mutates internal V2 state, so submit a copy.
        const v2 = V2Transaction.fromBytes(this.#v2.toBytes());
        return new Response<R>(await v2.execute(client._v2), client);
    }
}
