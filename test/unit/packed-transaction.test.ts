import { describe, expect, it } from "vitest";

import {
    createClient,
    PackedTransaction,
    PrivateKey,
    PrivateKeySigner,
    SdkError,
} from "../../src/v3/index.js";
import {
    localAccount,
    NODES,
    OFFLINE_NETWORK,
    payout,
    recording,
} from "../utils/fixtures.js";

describe("Transaction.pack", () => {
    it("produces one distinct body per target node and no signatures", () => {
        const packed = payout().pack(localAccount(), NODES);

        const bodies = packed.signableBodies();
        expect(bodies.map((b) => b.node.toString())).toEqual(NODES.map(String));
        expect(
            new Set(bodies.map((b) => Buffer.from(b.bytes).toString("hex")))
                .size,
        ).toBe(3);
        expect(packed.nodeSignatures).toEqual([]);
    });

    it("binds the transaction id to the payer", () => {
        const payer = localAccount("0.0.4242");
        expect(
            payout().pack(payer, NODES).transactionId.accountId.toString(),
        ).toBe("0.0.4242");
    });
});

describe("PackedTransaction.sign", () => {
    it("asks the signer once per target node", async () => {
        const signer = recording(
            new PrivateKeySigner(PrivateKey.generate("ED25519")),
        );
        const packed = await payout().pack(localAccount(), NODES).sign(signer);

        expect(signer.calls).toHaveLength(NODES.length);
        expect(packed.nodeSignatures).toHaveLength(NODES.length);
        expect(
            packed.nodeSignatures.every((s) =>
                s.publicKey.equals(signer.publicKey),
            ),
        ).toBe(true);
    });

    it("returns a new instance and leaves the original unsigned", async () => {
        const unsigned = payout().pack(localAccount(), NODES);
        const signed = await unsigned.sign(
            new PrivateKeySigner(PrivateKey.generate("ED25519")),
        );

        expect(unsigned.nodeSignatures).toEqual([]);
        expect(signed.nodeSignatures).toHaveLength(3);
    });

    it("keeps transaction id, nodes and signatures through toBytes/fromBytes", async () => {
        const payer = localAccount();
        const signed = await payout().pack(payer, NODES).sign(payer);
        const restored = PackedTransaction.fromBytes(signed.toBytes());

        expect(restored.transactionId.toString()).toBe(
            signed.transactionId.toString(),
        );
        expect(restored.nodes.map(String)).toEqual(NODES.map(String));
        expect(restored.nodeSignatures).toHaveLength(3);
    });

    it("collects signatures of several keys across serialization", async () => {
        const payer = localAccount();
        const a = new PrivateKeySigner(PrivateKey.generate("ED25519"));
        const b = new PrivateKeySigner(PrivateKey.generate("ECDSA_SECP256K1"));

        const bytes = payout().pack(payer, NODES).toBytes();
        const signedA = (
            await PackedTransaction.fromBytes(bytes).sign(a)
        ).toBytes();
        const signedB = await PackedTransaction.fromBytes(signedA).sign(b);
        const keys = new Set(
            signedB.nodeSignatures.map((s) => s.publicKey.toString()),
        );

        expect(keys).toEqual(
            new Set([a.publicKey.toString(), b.publicKey.toString()]),
        );
    });
});

describe("PackedTransaction.sign(signatures)", () => {
    it("attaches signatures produced out of process", async () => {
        const packed = payout().pack(localAccount(), NODES);
        const key = PrivateKey.generate("ECDSA_SECP256K1");
        const signatures = packed.signableBodies().map((body) => ({
            node: body.node,
            publicKey: key.createPublicKey(),
            signature: key.sign(body.bytes),
        }));

        expect(packed.sign(signatures).nodeSignatures).toHaveLength(3);
    });

    it("rejects a missing node with incomplete-signatures-error", async () => {
        const packed = payout().pack(localAccount(), NODES);
        const all = (
            await packed.sign(
                new PrivateKeySigner(PrivateKey.generate("ED25519")),
            )
        ).nodeSignatures;

        expect(() => packed.sign(all.slice(1))).toThrow(
            expect.objectContaining({
                code: "incomplete-signatures-error",
            }) as SdkError,
        );
    });

    it("rejects a node that is not a target with unknown-node-error", async () => {
        const packed = payout().pack(localAccount(), NODES.slice(0, 2));
        const other = await payout()
            .pack(localAccount(), NODES)
            .sign(new PrivateKeySigner(PrivateKey.generate("ED25519")));

        const outside = other.nodeSignatures.filter((s) =>
            s.node.equals(NODES[2]!),
        );

        expect(() => packed.sign(outside)).toThrow(
            expect.objectContaining({ code: "unknown-node-error" }) as SdkError,
        );
    });

    it("rejects a signature over other bytes with invalid-signature-error", async () => {
        const packed = payout().pack(localAccount(), NODES);
        const other = await payout()
            .pack(localAccount(), NODES)
            .sign(new PrivateKeySigner(PrivateKey.generate("ED25519")));

        expect(() => packed.sign(other.nodeSignatures)).toThrow(
            expect.objectContaining({
                code: "invalid-signature-error",
            }) as SdkError,
        );
    });
});

describe("HieroClient", () => {
    it("selects nodesPerTransaction distinct nodes for signWithOperator", async () => {
        const operator = localAccount();
        const client = createClient(OFFLINE_NETWORK, operator, {
            nodesPerTransaction: 2,
        });
        try {
            const packed = await payout().signWithOperator(client);
            expect(packed.nodes).toHaveLength(2);
            expect(packed.nodeSignatures).toHaveLength(2);
            expect(
                packed.transactionId.accountId.equals(operator.accountId),
            ).toBe(true);
        } finally {
            client.close();
        }
    });
});
