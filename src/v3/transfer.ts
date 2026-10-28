// Facade for the HBAR part of `TransferTransaction`
// (spec/consensus-node-client/transactions-accounts.md).

import {
    Hbar,
    TransferTransaction as V2TransferTransaction,
} from "@hiero-ledger/sdk";

import type { AccountId } from "./ledger.js";
import { Transaction } from "./transactions.js";
import type { Receipt } from "./transactions.js";

export const TINYBARS_PER_HBAR = 100_000_000n;

/** One HBAR leg. `amount` is in tinybars: negative debits, positive credits. */
export interface HbarTransfer {
    readonly accountId: AccountId;
    readonly amount: bigint;
    readonly approved: boolean;
}

export type TransferReceipt = Receipt;

export class TransferTransaction extends Transaction<TransferReceipt> {
    readonly #hbarTransfers: HbarTransfer[] = [];

    get hbarTransfers(): readonly HbarTransfer[] {
        return [...this.#hbarTransfers];
    }

    addHbarTransfer(
        accountId: AccountId,
        tinybars: bigint,
        approved = false,
    ): this {
        this.#hbarTransfers.push({ accountId, amount: tinybars, approved });
        return this;
    }

    protected _buildV2(): V2TransferTransaction {
        const v2 = new V2TransferTransaction();
        for (const t of this.#hbarTransfers) {
            const amount = Hbar.fromTinybars(t.amount.toString());
            if (t.approved) {
                v2.addApprovedHbarTransfer(t.accountId._toV2(), amount);
            } else {
                v2.addHbarTransfer(t.accountId._toV2(), amount);
            }
        }
        return v2;
    }
}
