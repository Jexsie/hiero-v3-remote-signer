/** Error ids from the spec's `@@throws(...)` annotations, plus facade additions. */
export type SdkErrorCode =
    | "unknown-node-error"
    | "incomplete-signatures-error"
    // Not in the spec, see F9.
    | "invalid-signature-error";

export class SdkError extends Error {
    readonly code: SdkErrorCode;

    constructor(code: SdkErrorCode, message: string) {
        super(`${code}: ${message}`);
        this.name = "SdkError";
        this.code = code;
    }
}
