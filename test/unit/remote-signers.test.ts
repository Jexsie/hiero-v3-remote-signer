import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { afterEach, describe, expect, it } from "vitest";

import { AwsKmsSigner } from "../../src/signers/aws/index.js";
import { VaultTransitSigner } from "../../src/signers/vault/index.js";
import { Account, PackedTransaction } from "../../src/v3/index.js";
import { installFakeKms, makeKey } from "../utils/fake-kms.js";
import {
    createFakeVault,
    makeTransitKey,
    VAULT_ADDRESS,
    VAULT_TOKEN,
} from "../utils/fake-vault-transit.js";
import {
    localAccount,
    NODES,
    payout,
    recording,
    TREASURY,
} from "../utils/fixtures.js";

const kmsClient = () => new KMSClient({ region: "eu-central-1" });

describe("AwsKmsSigner as a V3 TransactionSigner", () => {
    let mock: ReturnType<typeof installFakeKms> | undefined;
    afterEach(() => mock?.restore());

    for (const spec of ["ECC_SECG_P256K1", "ECC_NIST_EDWARDS25519"] as const) {
        it(`signs every node body with a ${spec} key, one KMS call per node`, async () => {
            const key = makeKey(spec);
            mock = installFakeKms([key]);
            const signer = await AwsKmsSigner.create({
                keyId: key.alias,
                client: kmsClient(),
            });

            const packed = await payout()
                .pack(localAccount(), NODES)
                .sign(signer);

            expect(signer.publicKey.algorithm).toBe(
                spec === "ECC_SECG_P256K1" ? "ECDSA_SECP256K1" : "ED25519",
            );
            expect(packed.nodeSignatures).toHaveLength(NODES.length);
            expect(mock.commandCalls(SignCommand)).toHaveLength(NODES.length);
        });
    }

    it("is the payer's signer when the KMS key owns the operator account", async () => {
        const key = makeKey("ECC_SECG_P256K1");
        mock = installFakeKms([key]);
        const kms = recording(
            await AwsKmsSigner.create({
                keyId: key.keyId,
                client: kmsClient(),
            }),
        );
        const operator = new Account(TREASURY, kms);

        const packed = await payout().sign(operator, NODES);

        expect(packed.transactionId.accountId.equals(TREASURY)).toBe(true);
        expect(kms.calls).toHaveLength(NODES.length);
    });
});

describe("VaultTransitSigner as a V3 TransactionSigner", () => {
    it("signs every node body, one transit call per node", async () => {
        const key = makeTransitKey("ed25519");
        const vault = createFakeVault([key]);
        const signer = await VaultTransitSigner.create({
            address: VAULT_ADDRESS,
            token: VAULT_TOKEN,
            keyName: key.name,
            fetch: vault.fetch,
        });

        const packed = await payout().pack(localAccount(), NODES).sign(signer);

        expect(packed.nodeSignatures).toHaveLength(NODES.length);
        expect(
            vault.requests.filter((r) => r.url.includes("/sign/")),
        ).toHaveLength(NODES.length);
    });
});

describe("2-of-3 approval across backends", () => {
    let mock: ReturnType<typeof installFakeKms> | undefined;
    afterEach(() => mock?.restore());

    it("collects KMS and Vault signatures on bytes passed between parties", async () => {
        const financeKey = makeKey("ECC_SECG_P256K1");
        mock = installFakeKms([financeKey]);
        const operationsKey = makeTransitKey("ed25519");
        const vault = createFakeVault([operationsKey]);
        const coordinator = localAccount("0.0.3000");

        // Coordinator packs and pays; the payout debits the treasury.
        const proposal = (await payout().sign(coordinator, NODES)).toBytes();

        // Finance approves in its own environment with AWS KMS.
        const finance = await AwsKmsSigner.create({
            keyId: financeKey.alias,
            client: kmsClient(),
        });
        const approvedOnce = (
            await PackedTransaction.fromBytes(proposal).sign(finance)
        ).toBytes();

        // Operations approves in its own environment with Vault.
        const operations = await VaultTransitSigner.create({
            address: VAULT_ADDRESS,
            token: VAULT_TOKEN,
            keyName: operationsKey.name,
            fetch: vault.fetch,
        });
        const approvedTwice =
            await PackedTransaction.fromBytes(approvedOnce).sign(operations);

        const signers = new Set(
            approvedTwice.nodeSignatures.map((s) => s.publicKey.toString()),
        );
        expect(signers).toEqual(
            new Set([
                coordinator.signer.publicKey.toString(),
                finance.publicKey.toString(),
                operations.publicKey.toString(),
            ]),
        );
        expect(approvedTwice.nodeSignatures).toHaveLength(3 * NODES.length);
    });
});
