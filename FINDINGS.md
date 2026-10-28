# Findings: V3 signing API vs. real remote signers

What implementing AWS KMS and HashiCorp Vault signers against the V3 spec
showed. Each finding points at the spec text it is about and at the facade
code that deviates from it. Spec references are to
[hiero-sdk-v3-prototyping](https://github.com/hiero-hackers/hiero-sdk-v3-prototyping)
at commit `a8faaf0`.

Status legend: **confirmed** = needed to make the flows work at all;
**proposed** = works without it, but the spec as written is unclear or
awkward; **open** = observed, no proposal yet.

## F1. `TransactionSigner.signTransaction` must be async — confirmed

Spec (`client.md`): `NodeSignature signTransaction(transactionBytes: bytes, node: AccountId)`.

Every remote backend is a network call (KMS `Sign`, Vault `POST transit/sign`,
PKCS#11 over a network HSM). A synchronous signature forces blocking I/O in
Java and is not implementable at all in JavaScript.

Proposal: `@@async NodeSignature signTransaction(...)`.
Facade: `src/v3/client.ts` (`TransactionSigner`).

## F2. `TransactionSigner` needs its public key — confirmed

Every `NodeSignature` carries a `publicKey`, and callers need the key to
create the account it controls (see `examples/setup-accounts.ts`). Without
it on the abstraction, each implementation invents its own accessor.

Proposal: `@@immutable publicKey: PublicKey` on `TransactionSigner`. Also,
`client.md` uses `PublicKey` without importing it (`requires {PrivateKey} from keys`).
Facade: `src/v3/client.ts`.

## F3. `Account` forces an in-memory `PrivateKey` — proposed

Spec: `Account { accountId, privateKey }`, plus a separate
`HieroClient.transactionSigner` and a three-argument `createClient`.

An operator whose key is in KMS has no `PrivateKey`, so the caller has to
build an `Account` with some key it does not have and pass the signer next to
it. Two places then describe "who signs for the operator".

Proposal: `Account { accountId, signer: TransactionSigner }`; an in-memory key
is one `TransactionSigner` implementation (`PrivateKeySigner`). This removes
`HieroClient.transactionSigner`, the third `createClient` overload, and the
`sign(payer: Account, …)` vs. `sign(payerId, signer, …)` split on `Transaction`.
Facade: `src/v3/client.ts` (`Account`, `PrivateKeySigner`, `HieroClient`).

## F4. The signer should take a `NodeBody` — proposed

Spec: `signTransaction(transactionBytes: bytes, node: AccountId)`. The name
suggests the whole transaction; what must be signed is the serialized
`TransactionBody` for that node. The spec already has the exact type for this
(`NodeBody`, in `transactions.md`) and `signableBodies()` returns it.

Proposal: `signTransaction(body: NodeBody)`. `NodeBody` then has to move to
(or be imported into) `consensusnode.client`.

## F5. Who hashes, and in which signature encoding — proposed

Not specified. What the backends need:

- Ed25519: sign the raw body bytes. AWS KMS limits `RAW` messages to 4096
  bytes, so large bodies (file appends) cannot be signed with an Ed25519 KMS key.
- ECDSA secp256k1: Hiero verifies over Keccak-256 of the body. No cloud KMS
  offers Keccak, so the signer hashes locally and sends a `DIGEST`.
- KMSs return DER-encoded ECDSA signatures with high `s` about half the
  time; Hiero needs 64-byte `r || s` with low `s`.

Proposal: specify that `signTransaction` receives the raw body bytes, that the
signer applies the algorithm's digest, and that `NodeSignature.signature` is
the 64-byte form for both algorithms. Without this, every signer author
rediscovers it (as hiero-remote-signer did).

## F6. Async signing splits the `sign` overloads — open

Because of F1, `PackedTransaction.sign(signer)`, `sign(account)`,
`Transaction.sign(...)` and `signWithOperator(...)` become async, while
`PackedTransaction.sign(signatures)` stays sync. The facade keeps one
overloaded `sign` (`src/v3/transactions.ts`), which type-checks but means
`sign(x)` returns a Promise or not depending on the argument type.

Question: keep the overload set, or rename the sync one (e.g.
`addSignatures(signatures)`)?

## F7. Signing cost scales with the number of target nodes — open

One key contributes one signature per target node (`transactions.md`,
"Why one signing key contributes N signatures"). With a remote signer that is
N billed, rate-limited, audit-logged backend calls per key and transaction.
The tests assert it: `test/unit/remote-signers.test.ts` counts one KMS `Sign`
and one transit call per node.

The spec also gives callers no way to obtain `nodes` for `pack(payer, nodes)`.
The facade adds `HieroClient.selectNodes()` and a `nodesPerTransaction` option
(default 3).

Questions: should the spec define node selection on the client? Should
`TransactionSigner` get a batch method (`signTransactions(bodies: list<NodeBody>)`)
so backends that support batching can use it?

## F8. Signer lifecycle — open

The PKCS#11 signer in hiero-remote-signer holds a session and needs `close()`.
AWS KMS and Vault do not, so this PoC does not exercise it. Whether
`TransactionSigner` should be closeable (or that is left to implementations)
is open.

## F9. Attaching a signature that does not verify — proposed

`PackedTransaction.sign(signatures)` documents `unknown-node-error` and
`incomplete-signatures-error`. A signature over the wrong bytes is only
detected at submit time as `INVALID_SIGNATURE`. Verification is cheap and
local, so the facade checks it on attach and throws
`invalid-signature-error`. Proposal: add that error id to the spec.

## F10. No wire format for `NodeBody` / `NodeSignature` — open

Out-of-process signing (`transactions.md` example 5) ships bodies to a signing
service and signatures back. The spec defines `PackedTransaction.toBytes()`
but nothing for these two types, so every pipeline invents its own JSON
(`examples/out-of-process.ts` does).

## F11. `pack` takes an `Account` but only needs the payer id — proposed

`pack(payer: Account, nodes)` only uses the account id to build the
`TransactionId`. With F3 an `Account` carries a signer, so an application
that packs for an out-of-process signer needs a placeholder signer
(`examples/out-of-process.ts`). Even with the spec's `Account`, it needs a
private key it does not have.

Proposal: `pack(payerId: AccountId, nodes)`.
