// A treasury guarded by a 2-of-3 threshold key pays out. The coordinator
// packs and pays; finance (AWS KMS) and operations (Vault) approve in their
// own environments. Only the packed bytes travel between parties.
//
// Pass `--one-approval` to stop after finance: the network then rejects the
// payout with INVALID_SIGNATURE.

import {
    AccountId,
    createClient,
    PackedTransaction,
    TINYBARS_PER_HBAR,
    TransferTransaction,
} from "../src/v3/index.js";
import {
    env,
    fundingAccount,
    kmsSigner,
    logged,
    network,
    vaultSigner,
} from "./shared.js";

const coordinator = fundingAccount();
const treasury = AccountId.fromString(env("TREASURY_ACCOUNT_ID"));
const client = createClient(network(), coordinator);

try {
    // Coordinator: pack and add the payer signature.
    const proposal = (
        await new TransferTransaction()
            .addHbarTransfer(treasury, -TINYBARS_PER_HBAR)
            .addHbarTransfer(coordinator.accountId, TINYBARS_PER_HBAR)
            .signWithOperator(client)
    ).toBytes();
    console.log(`Proposal: ${proposal.length} bytes`);

    // Finance, in its own environment.
    const finance = logged("finance/aws-kms", await kmsSigner());
    let approved = (
        await PackedTransaction.fromBytes(proposal).sign(finance)
    ).toBytes();

    // Operations, in its own environment.
    if (!process.argv.includes("--one-approval")) {
        const operations = logged("operations/vault", await vaultSigner());
        approved = (
            await PackedTransaction.fromBytes(approved).sign(operations)
        ).toBytes();
    }

    // Coordinator submits.
    const response = await PackedTransaction.fromBytes(approved).submit(client);
    const receipt = await response.queryReceipt();
    console.log(`${receipt.transactionId.toString()}: ${receipt.status.name}`);
} finally {
    client.close();
}
