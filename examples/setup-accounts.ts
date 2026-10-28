// Creates the accounts the other examples use. Account creation is not part
// of the facade, so this script uses the V2 SDK directly.
//
// 1. KMS_ACCOUNT_ID: an account whose key is the AWS KMS public key.
// 2. TREASURY_ACCOUNT_ID: an account guarded by a 2-of-3 threshold key of
//    finance (AWS KMS), operations (Vault) and compliance (a new local key).

import {
    AccountCreateTransaction,
    Client,
    Hbar,
    KeyList,
    PrivateKey as V2PrivateKey,
} from "@hiero-ledger/sdk";

import { env, fundingAccount, kmsSigner, vaultSigner } from "./shared.js";

const funding = fundingAccount();
const client = Client.forName(
    (process.env.NETWORK ?? "hedera-testnet").replace(/^hedera-/, ""),
);
client.setOperator(
    funding.accountId.toString(),
    process.env.FUNDING_KEY_ALGORITHM === "ED25519"
        ? V2PrivateKey.fromStringED25519(env("FUNDING_PRIVATE_KEY"))
        : V2PrivateKey.fromStringECDSA(env("FUNDING_PRIVATE_KEY")),
);

try {
    const finance = await kmsSigner();
    const operations = await vaultSigner();
    const compliance = V2PrivateKey.generateED25519();

    const kmsAccount = await new AccountCreateTransaction()
        .setKeyWithoutAlias(finance.publicKey._v2)
        .setInitialBalance(new Hbar(5))
        .execute(client)
        .then((r) => r.getReceipt(client));

    const treasury = await new AccountCreateTransaction()
        .setKeyWithoutAlias(
            new KeyList(
                [
                    finance.publicKey._v2,
                    operations.publicKey._v2,
                    compliance.publicKey,
                ],
                2,
            ),
        )
        .setInitialBalance(new Hbar(5))
        .execute(client)
        .then((r) => r.getReceipt(client));

    console.log("Add these lines to .env:\n");
    console.log(`KMS_ACCOUNT_ID=${kmsAccount.accountId!.toString()}`);
    console.log(`TREASURY_ACCOUNT_ID=${treasury.accountId!.toString()}`);
    console.log(`COMPLIANCE_PRIVATE_KEY=${compliance.toStringDer()}`);
} finally {
    client.close();
}
