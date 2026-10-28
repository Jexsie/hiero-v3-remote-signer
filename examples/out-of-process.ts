// Out-of-process signing: the application packs the transaction and hands the
// signable bodies to a signing service as JSON; the signatures come back as
// JSON and are attached with `PackedTransaction.sign(signatures)`. Here both
// sides run in one process, but they share nothing except the JSON strings.
//
// The spec defines no wire format for NodeBody or NodeSignature (F10), so the
// JSON shape below is this example's own.

import {
    Account,
    AccountId,
    createClient,
    PackedTransaction,
    PublicKey,
    TransferTransaction,
} from "../src/v3/index.js";
import type { KeyAlgorithm, NodeSignature } from "../src/v3/index.js";
import { env, fundingAccount, kmsSigner, network } from "./shared.js";

interface SigningJob {
    bodies: { node: string; bytes: string }[];
}
interface SigningResult {
    algorithm: KeyAlgorithm;
    publicKey: string;
    signatures: { node: string; signature: string }[];
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

/** The signing service: owns the KMS credentials, sees only bodies. */
async function signingService(jobJson: string): Promise<string> {
    const job = JSON.parse(jobJson) as SigningJob;
    const signer = await kmsSigner();
    const signatures = [];
    for (const body of job.bodies) {
        const s = await signer.signTransaction({
            node: AccountId.fromString(body.node),
            bytes: unhex(body.bytes),
        });
        signatures.push({ node: body.node, signature: hex(s.signature) });
    }
    const result: SigningResult = {
        algorithm: signer.publicKey.algorithm,
        publicKey: hex(signer.publicKey.rawBytes),
        signatures,
    };
    return JSON.stringify(result);
}

// The application: knows the KMS account's id, but has no signer for it.
// `pack` only needs the payer's id, yet the spec signature takes an Account,
// so a placeholder signer is needed (F11).
const payerId = AccountId.fromString(env("KMS_ACCOUNT_ID"));
const noSigner = {
    publicKey: PublicKey.fromRawBytes("ED25519", new Uint8Array(32)),
    signTransaction: () =>
        Promise.reject(new Error("signing happens out of process")),
};
const client = createClient(network(), fundingAccount());

try {
    const packed = new TransferTransaction()
        .addHbarTransfer(payerId, -1n)
        .addHbarTransfer(fundingAccount().accountId, 1n)
        .pack(new Account(payerId, noSigner), client.selectNodes());

    const stored = packed.toBytes();
    const job: SigningJob = {
        bodies: packed
            .signableBodies()
            .map((b) => ({ node: b.node.toString(), bytes: hex(b.bytes) })),
    };

    const result = JSON.parse(
        await signingService(JSON.stringify(job)),
    ) as SigningResult;
    const publicKey = PublicKey.fromRawBytes(
        result.algorithm,
        unhex(result.publicKey),
    );
    const signatures: NodeSignature[] = result.signatures.map((s) => ({
        node: AccountId.fromString(s.node),
        publicKey,
        signature: unhex(s.signature),
    }));

    const signed = PackedTransaction.fromBytes(stored).sign(signatures);
    const receipt = await (await signed.submit(client)).queryReceipt();
    console.log(`${receipt.transactionId.toString()}: ${receipt.status.name}`);
} finally {
    client.close();
}
