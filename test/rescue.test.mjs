import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compact-rescue-test-"));
process.env.CODEX_RESCUE_STATE_PATH = path.join(tmp, "sessions.json");
process.env.CODEX_RESCUE_LOG_PATH = path.join(tmp, "watcher.log");
process.env.CODEX_RESCUE_DRY_RUN_PATH = path.join(tmp, "dry-run.jsonl");
process.env.CODEX_RESCUE_DRY_RUN = "1";

const rescue = await import(`../scripts/rescue.mjs?test=${Date.now()}`);

test("detectCompactFailureLine matches remote compact stream errors only", () => {
  assert.equal(
    rescue.detectCompactFailureLine("Error running remote compact task: stream disconnected before completion: /responses/compact"),
    true
  );
  assert.equal(rescue.detectCompactFailureLine("normal compact prose in a README"), false);
});

test("parseTranscriptMeta reads session id and latest turn settings", () => {
  const transcript = path.join(tmp, "rollout-2026-05-20T00-00-00-11111111-2222-4333-8444-555555555555.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: "11111111-2222-4333-8444-555555555555",
        cwd: "C:\\work",
        model_provider: "openai"
      }
    }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        cwd: "C:\\work\\next",
        model: "gpt-5.5",
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" }
      }
    }),
    ""
  ].join("\n"), "utf8");

  const meta = rescue.parseTranscriptMeta(transcript);
  assert.equal(meta.sessionId, "11111111-2222-4333-8444-555555555555");
  assert.equal(meta.cwd, "C:\\work\\next");
  assert.equal(meta.model, "gpt-5.5");
  assert.equal(meta.approvalPolicy, "never");
  assert.equal(meta.sandboxType, "danger-full-access");
});

test("scanSessionOnce dry-runs fallback then original resume after a new compact failure", async () => {
  const sessionId = "019e4999-b770-72e0-a0db-a680eee09999";
  const transcript = path.join(tmp, `rollout-2026-05-20T00-01-00-${sessionId}.jsonl`);
  const initial = [
    JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: tmp } }),
    JSON.stringify({
      type: "turn_context",
      payload: {
        cwd: tmp,
        model: "gpt-5.5",
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" }
      }
    }),
    ""
  ].join("\n");
  fs.writeFileSync(transcript, initial, "utf8");
  const startSize = fs.statSync(transcript).size;
  fs.appendFileSync(transcript, JSON.stringify({
    type: "event_msg",
    payload: {
      type: "error",
      message: "Error running remote compact task: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses/compact)"
    }
  }) + "\n", "utf8");

  const session = {
    enabled: true,
    sessionId,
    transcriptPath: transcript,
    cwd: tmp,
    originalModel: "gpt-5.5",
    fallbackModel: "gpt-5.4-mini",
    approvalPolicy: "never",
    sandboxType: "danger-full-access",
    lastScannedSize: startSize,
    rescueInProgress: false
  };

  const result = await rescue.scanSessionOnce(session, { dryRun: true, quietMs: 1, maxSettleMs: 5 });
  assert.equal(result.rescued, true);

  const runs = fs.readFileSync(process.env.CODEX_RESCUE_DRY_RUN_PATH, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(runs.length, 2);
  assert.equal(runs[0].model, "gpt-5.4-mini");
  assert.equal(runs[0].prompt, "继续");
  assert.equal(runs[1].model, "gpt-5.5");
});

test("buildResumeArgs preserves session model override and safety settings", () => {
  const args = rescue.buildResumeArgs({
    sessionId: "abc",
    cwd: "C:\\work",
    approvalPolicy: "never",
    sandboxType: "danger-full-access"
  }, "gpt-5.4-mini", "继续");

  assert.deepEqual(args.slice(0, 8), ["-a", "never", "-s", "danger-full-access", "-C", "C:\\work", "exec", "resume"]);
  assert.equal(args.includes("gpt-5.4-mini"), true);
  assert.equal(args.at(-1), "继续");
});
