export declare function isAuthenticated(): boolean;
/**
 * Resolve the qodercli binary. Search order:
 *  1. PATH
 *  2. ~/.qoder/local/qodercli
 *  3. ~/.qoder/bin/qodercli/qodercli-<version> (latest)
 * Returns null when nothing is found.
 */
export declare function findQoderCLI(): string | null;
//# sourceMappingURL=auth.d.ts.map