import {
    Account,
    AccountId,
    PrivateKey,
    TransferTransaction,
    TINYBARS_PER_HBAR,
} from "../../src/v3/index.js";
import type {
    NetworkSetting,
    NodeBody,
    NodeSignature,
    TransactionSigner,
} from "../../src/v3/index.js";

/** Three nodes that are never contacted; packing and signing are offline. */
export const OFFLINE_NETWORK: NetworkSetting = {
    identifier: "offline",
    consensusNodes: [3n, 4n, 5n].map((num, i) => ({
        address: `127.0.0.1:${50211 + i}`,
        account: new AccountId(0n, 0n, num),
    })),
};

export const NODES = OFFLINE_NETWORK.consensusNodes.map((n) => n.account);

export const TREASURY = AccountId.fromString("0.0.1001");
export const RECIPIENT = AccountId.fromString("0.0.1002");

export function payout(): TransferTransaction {
    return new TransferTransaction()
        .addHbarTransfer(TREASURY, -TINYBARS_PER_HBAR)
        .addHbarTransfer(RECIPIENT, TINYBARS_PER_HBAR);
}

export function localAccount(id = "0.0.2000"): Account {
    return Account.ofPrivateKey(
        AccountId.fromString(id),
        PrivateKey.generate("ED25519"),
    );
}

/** Wraps a signer and records every body it was asked to sign. */
export function recording(
    signer: TransactionSigner,
): TransactionSigner & { calls: NodeBody[] } {
    const calls: NodeBody[] = [];
    return {
        publicKey: signer.publicKey,
        calls,
        signTransaction(body: NodeBody): Promise<NodeSignature> {
            calls.push(body);
            return signer.signTransaction(body);
        },
    };
}
