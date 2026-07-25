export async function* idlePrompt(signal) {
    if (!signal.aborted) {
        await new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
    }
}
//# sourceMappingURL=sdk-session.js.map