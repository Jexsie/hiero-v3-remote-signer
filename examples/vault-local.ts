// Signs a packed transaction with a real Vault transit key through the V3 API.
// Runs against the dev Vault from `npm run vault:up`; needs no testnet account
// and submits nothing. Packing and signing are offline, so the target nodes
// below are never contacted.
//
// Override the Vault defaults with VAULT_ADDR, VAULT_TOKEN and VAULT_KEY_NAME.

import { VaultTransitSigner } from "../src/signers/vault/index.js";
import {
    Account,
    AccountId,
    PackedTransaction,
    PrivateKey,
    TINYBARS_PER_HBAR,
    TransferTransaction,
} from "../src/v3/index.js";
import { logged } from "./shared.js";

const nodes = [3n, 4n, 5n].map((num) => new AccountId(0n, 0n, num));
const payer = Account.ofPrivateKey(
    AccountId.fromString("0.0.1001"),
    PrivateKey.generate("ED25519"),
);

const vault = await VaultTransitSigner.create({
    address: process.env.VAULT_ADDR ?? "http://127.0.0.1:8200",
    token: process.env.VAULT_TOKEN ?? "root",
    keyName: process.env.VAULT_KEY_NAME ?? "hiero-operations",
});
console.log(
    `Vault key ${vault.keyName} v${vault.keyVersion}: ${vault.publicKey.toString()}`,
);

const packed = new TransferTransaction()
    .addHbarTransfer(payer.accountId, -TINYBARS_PER_HBAR)
    .addHbarTransfer(AccountId.fromString("0.0.1002"), TINYBARS_PER_HBAR)
    .pack(payer, nodes);
console.log(
    `Packed ${packed.transactionId.toString()} for ${nodes.length} nodes`,
);

// Round-trip through bytes, as if the transaction came from another party.
const signed = await PackedTransaction.fromBytes(packed.toBytes()).sign(
    logged("vault", vault),
);

const bodies = new Map(
    signed.signableBodies().map((b) => [b.node.toString(), b.bytes]),
);
for (const s of signed.nodeSignatures) {
    const valid = s.publicKey.verify(
        bodies.get(s.node.toString())!,
        s.signature,
    );
    console.log(
        `  node ${s.node.toString()}: ${Buffer.from(s.signature).toString("hex").slice(0, 16)}… ${valid ? "valid" : "INVALID"}`,
    );
}
