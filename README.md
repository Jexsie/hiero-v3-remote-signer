# hiero-v3-remote-signer-poc

A proof of concept that tests the signing API of the
[Hiero SDK V3 specification](https://github.com/hiero-hackers/hiero-sdk-v3-prototyping/blob/main/spec/consensus-node-client/client.md)
against real remote signers: AWS KMS and HashiCorp Vault.

V3 exists only as a specification. This repository fakes the slice of it that
signing touches, as a thin TypeScript facade on top of the V2
[Hiero JavaScript SDK](https://github.com/hiero-ledger/hiero-sdk-js), and
ports the AWS KMS and Vault signers from
[hiero-remote-signer](https://github.com/Jexsie/hiero-remote-signer) to the
V3 `TransactionSigner`. What did not fit the spec is recorded in
[FINDINGS.md](FINDINGS.md). The findings are the deliverable; the code is
there to produce them.

**Not for production use.** The facade covers HBAR transfers only and exists
to be thrown away.

## What is faked

| V3 spec                                                                                                                                                    | Facade                   | Runs on V2                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| `keys`: `PublicKey`, `PrivateKey`, `KeyAlgorithm`                                                                                                          | `src/v3/keys.ts`         | `PublicKey`, `PrivateKey`                                                                    |
| `ledger`: `AccountId`, `TransactionId`, `NetworkSetting`                                                                                                   | `src/v3/ledger.ts`       | address books of `Client.forName`                                                            |
| `consensusnode.client`: `TransactionSigner`, `NodeSignature`, `Account`, `HieroClient`, `createClient`                                                     | `src/v3/client.ts`       | `Client` **without operator**, so V2 never signs implicitly                                  |
| `consensusnode.transactions`: `Transaction`, `pack`, `PackedTransaction`, `signableBodies`, `sign`, `toBytes`/`fromBytes`, `submit`, `Response`, `Receipt` | `src/v3/transactions.ts` | `freeze`, `signableNodeBodyBytesList`, `addSignature(SignatureMap)`, `execute`, `getReceipt` |
| `TransferTransaction` (HBAR legs only)                                                                                                                     | `src/v3/transfer.ts`     | `TransferTransaction`                                                                        |

Deviations from the spec are marked in the code with their finding number
(`F1` … `F11`).

Signers in `src/signers/`:

- `AwsKmsSigner`: `ECC_SECG_P256K1` and `ECC_NIST_EDWARDS25519` keys.
- `VaultTransitSigner`: Ed25519 transit keys (Vault and OpenBao).

The DER helpers in `src/der/`, the errors in `src/errors/` and the backend
fakes in `test/utils/` are copied from hiero-remote-signer.

## The V3 flows

```ts
// Operator key in KMS: pays for and signs everything the client sends.
const operator = new Account(
    AccountId.fromString("0.0.1234"),
    await AwsKmsSigner.create({ keyId }),
);
const client = createClient(getNetworkSetting("hedera-testnet"), operator);
const response = await new TransferTransaction()
    .addHbarTransfer(operator.accountId, -1n)
    .addHbarTransfer(recipient, 1n)
    .signWithOperatorAndSubmit(client);

// Multi-party: only bytes travel between parties.
const proposal = (await payout.signWithOperator(client)).toBytes();
const once = (
    await PackedTransaction.fromBytes(proposal).sign(kmsSigner)
).toBytes();
const twice = await PackedTransaction.fromBytes(once).sign(vaultSigner);
await twice.submit(client);

// Out of process: ship bodies, attach returned signatures.
const packed = transfer.pack(payer, client.selectNodes());
const bodies = packed.signableBodies(); // -> signing service
const signed = packed.sign(signaturesFromService); // NodeSignature[]
```

## Run it

Requires Node.js 20+ and Docker (for Vault).

```sh
npm install
npm test            # typecheck + unit tests, offline, against backend fakes
```

The unit tests pack and sign real transactions, with AWS KMS and Vault
replaced by the fakes from hiero-remote-signer. They also count backend calls
per transaction (F7).

### Against a local Vault

No testnet account or AWS needed:

```sh
npm run vault:up              # Vault dev server + Ed25519 transit key
npm run example:vault-local   # pack, sign with Vault via the V3 API, verify
npm run vault:down
```

The transaction is packed and signed for three nodes but never submitted.
Expect one Vault call per node and three valid signatures.

### Against testnet

1. `cp .env.example .env` and fill in a funded testnet account, an AWS KMS
   key and AWS credentials.
2. `npm run vault:up` starts a Vault dev server and creates the transit key.
3. `npm run example:setup` creates a KMS-owned account and a 2-of-3
   treasury (KMS, Vault, local key). Add the printed lines to `.env`.
4. Run the examples:

| Script                           | Shows                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `npm run example:operator`       | operator key in KMS, `signWithOperatorAndSubmit`                                                                    |
| `npm run example:multi-party`    | 2-of-3 approval across KMS and Vault via `toBytes`/`fromBytes` (add `-- --one-approval` to see `INVALID_SIGNATURE`) |
| `npm run example:out-of-process` | `signableBodies()` → JSON → signing service → `sign(signatures)`                                                    |

`npm run vault:down` stops Vault.

## License

[Apache 2.0](LICENSE)
