import { test } from "node:test";
import assert from "node:assert/strict";
import { accessTokenFromEnv, query, qodercliAuth } from "@qoder-ai/qoder-agent-sdk";
import { findQoderCLI, isAuthenticated } from "../dist/auth.js";

const enabled = process.env.QODER_E2E === "1";

test("authenticated Qoder SDK can complete a free text turn", { skip: !enabled }, async () => {
  const cli = findQoderCLI();
  const hasPAT = Boolean(process.env.QODER_PERSONAL_ACCESS_TOKEN);
  assert.ok(hasPAT || isAuthenticated(), "Qoder authentication is required");

  const controller = new AbortController();
  const q = query({
    prompt: "Reply with exactly OK.",
    options: {
      auth: hasPAT ? accessTokenFromEnv() : qodercliAuth(),
      model: "lite",
      permissionMode: "default",
      persistSession: false,
      maxTurns: 1,
      abortController: controller,
      ...(cli ? { pathToQoderCLIExecutable: cli } : {}),
    },
  });

  let result;
  try {
    for await (const message of q) {
      if (message.type === "result") result = message;
    }
  } finally {
    controller.abort();
    await q.return(undefined).catch(() => {});
  }

  assert.ok(result, "the SDK must emit a result message");
  assert.equal(result.is_error, false, JSON.stringify(result));
});
