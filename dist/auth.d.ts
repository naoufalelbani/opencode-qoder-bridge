export declare function isAuthenticated(): boolean;
/**
 * Resolve the qodercli binary. Search order:
 *  1. PATH
 *  2. ~/.qoder/local/qodercli
 *  3. ~/.qoder/bin/qodercli/qodercli-<version> (latest)
 * Returns null when no separately installed CLI is found. The Qoder SDK can
 * still run through its bundled Worker runtime when credentials are present.
 */
export declare function findQoderCLI(): string | null;
//# sourceMappingURL=auth.d.ts.map