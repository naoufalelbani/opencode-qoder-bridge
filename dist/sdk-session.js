export async function* idlePrompt(signal) {
    if (signal.aborted)
        return;
    let abortHandler;
    try {
        await new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                resolve();
            };
            abortHandler = finish;
            signal.addEventListener("abort", abortHandler, { once: true });
            // Abort can happen between the initial check and listener registration.
            // Re-check after registering so the SDK never waits on an already-lost
            // cancellation event.
            if (signal.aborted)
                finish();
        });
    }
    finally {
        if (abortHandler) {
            try {
                signal.removeEventListener("abort", abortHandler);
            }
            catch { /* ignore */ }
        }
    }
}
//# sourceMappingURL=sdk-session.js.map