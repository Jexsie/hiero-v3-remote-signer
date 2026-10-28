// The operator's key lives in AWS KMS. Every transaction the client sends is
// paid for and signed through KMS; the private key never enters this process.

import {
    Account,
    AccountId,
    createClient,
    TransferTransaction,
} from "../src/v3/index.js";
import { env, fundingAccount, kmsSigner, logged, network } from "./shared.js";

const operator = new Account(
    AccountId.fromString(env("KMS_ACCOUNT_ID")),
    logged("aws-kms", await kmsSigner()),
);
const client = createClient(network(), operator);

try {
    console.log(
        `Paying from ${operator.accountId.toString()}, ${client.nodesPerTransaction} target nodes:`,
    );
    const response = await new TransferTransaction()
        .addHbarTransfer(operator.accountId, -1n)
        .addHbarTransfer(fundingAccount().accountId, 1n)
        .signWithOperatorAndSubmit(client);

    const receipt = await response.queryReceipt();
    console.log(`${receipt.transactionId.toString()}: ${receipt.status.name}`);
} finally {
    client.close();
}
