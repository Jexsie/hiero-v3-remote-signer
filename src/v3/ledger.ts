// Facade for the V3 `ledger` and `ledger.config` namespaces (spec/base/ledger.md,
// spec/base/ledger-config.md). Only numeric account ids are modelled; EVM and
// key aliases are out of scope for the signing PoC.

import {
    AccountId as V2AccountId,
    Client as V2Client,
    TransactionId as V2TransactionId,
} from "@hiero-ledger/sdk";

/** Numeric account id `shard.realm.num`. */
export class AccountId {
    readonly shard: bigint;
    readonly realm: bigint;
    readonly num: bigint;

    constructor(shard: bigint, realm: bigint, num: bigint) {
        this.shard = shard;
        this.realm = realm;
        this.num = num;
    }

    static fromString(value: string): AccountId {
        const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
        if (!match) {
            throw new Error(
                `illegal-format: "${value}" is not shard.realm.num`,
            );
        }
        return new AccountId(
            BigInt(match[1]!),
            BigInt(match[2]!),
            BigInt(match[3]!),
        );
    }

    /** @internal */
    static _fromV2(v2: V2AccountId): AccountId {
        return AccountId.fromString(v2.toString());
    }

    /** @internal */
    _toV2(): V2AccountId {
        return V2AccountId.fromString(this.toString());
    }

    equals(other: AccountId): boolean {
        return (
            this.shard === other.shard &&
            this.realm === other.realm &&
            this.num === other.num
        );
    }

    toString(): string {
        return `${this.shard}.${this.realm}.${this.num}`;
    }
}

/** Id of a transaction: payer plus valid-start timestamp. */
export class TransactionId {
    readonly accountId: AccountId;
    readonly validStart: Date;
    readonly #v2: V2TransactionId;

    private constructor(v2: V2TransactionId) {
        this.#v2 = v2;
        this.accountId = AccountId._fromV2(v2.accountId!);
        this.validStart = v2.validStart!.toDate();
    }

    /** @internal */
    static _fromV2(v2: V2TransactionId): TransactionId {
        return new TransactionId(v2);
    }

    toString(): string {
        return this.#v2.toString();
    }
}

/** A consensus node as the client sees it: where to reach it and its fee account. */
export interface ConsensusNode {
    /** `host:port` of the node's gRPC endpoint */
    readonly address: string;
    readonly account: AccountId;
}

/** The configuration needed to connect to one network. */
export interface NetworkSetting {
    readonly identifier: string;
    readonly consensusNodes: readonly ConsensusNode[];
}

const registry = new Map<string, NetworkSetting>();

export function registerNetworkSetting(
    identifier: string,
    setting: NetworkSetting,
): void {
    registry.set(identifier, setting);
}

/**
 * Returns a registered setting. `hedera-mainnet`, `hedera-testnet` and
 * `hedera-previewnet` are resolved from the V2 SDK's built-in address books;
 * `local` is a single-node local network (solo / local-node) on 127.0.0.1:50211.
 */
export function getNetworkSetting(identifier: string): NetworkSetting {
    const registered = registry.get(identifier);
    if (registered) return registered;

    const v2Name = identifier.match(
        /^hedera-(mainnet|testnet|previewnet)$/,
    )?.[1];
    if (v2Name) {
        const client = V2Client.forName(v2Name);
        try {
            return {
                identifier,
                consensusNodes: Object.entries(client.network).map(
                    ([address, account]) => ({
                        address,
                        account: AccountId._fromV2(
                            typeof account === "string"
                                ? V2AccountId.fromString(account)
                                : account,
                        ),
                    }),
                ),
            };
        } finally {
            client.close();
        }
    }
    if (identifier === "local") {
        return {
            identifier,
            consensusNodes: [
                {
                    address: "127.0.0.1:50211",
                    account: new AccountId(0n, 0n, 3n),
                },
            ],
        };
    }
    throw new Error(`not-found-error: no network setting "${identifier}"`);
}
