import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const PLUGIN_ROOT = path.dirname(SCRIPT_DIR);
const STATE_PATH = process.env.CODEX_RESCUE_STATE_PATH ?? path.join(PLUGIN_ROOT, "state", "sessions.json");
const LOG_PATH = process.env.CODEX_RESCUE_LOG_PATH ?? path.join(PLUGIN_ROOT, "logs", "watcher.log");
const DRY_RUN_PATH = process.env.CODEX_RESCUE_DRY_RUN_PATH ?? path.join(PLUGIN_ROOT, "state", "dry-run.jsonl");
const WATCHER_PID_PATH = process.env.CODEX_RESCUE_WATCHER_PID_PATH ?? path.join(PLUGIN_ROOT, "state", "watcher.pid");

const DEFAULT_FALLBACK_MODEL = "gpt-5.4-mini";
const DEFAULT_FALLBACK_PROMPT = "继续";
const DEFAULT_RESTORE_PROMPT =
  "继续。刚才 gpt-5.4-mini 仅用于完成上下文压缩救援；现在请按本会话原模型继续执行最新用户请求。若这条消息插入在任务中间，请把它视为恢复信号，优先接上 compact 失败前正在处理的工作。";

const DEFAULT_POLL_MS = 4000;
const DEFAULT_QUIET_MS = 6000;
const DEFAULT_MAX_SETTLE_MS = 45000;
const DEFAULT_RESUME_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

export function detectCompactFailureLine(line) {
  const message = compactFailureMessageFromTranscriptLine(line);
  return message ? detectCompactFailureText(message) : false;
}

export function detectCompactFailureText(text) {
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();
  const hasCompactEndpoint = lower.includes("/responses/compact");
  const hasCompactTask = lower.includes("remote compact task") || lower.includes("compact task");
  const hasFailure =
    lower.includes("error running remote compact task") ||
    lower.includes("stream disconnected") ||
    lower.includes("error sending request") ||
    lower.includes("failed") ||
    lower.includes("error");

  return (hasCompactEndpoint || hasCompactTask) && hasFailure;
}

function compactFailureMessageFromTranscriptLine(line) {
  let item;
  try {
    item = JSON.parse(line);
  } catch {
    return null;
  }

  if (item.type === "event_msg" && item.payload) {
    const payloadType = String(item.payload.type ?? "").toLowerCase();
    if (payloadType === "error" || payloadType === "stream_error") {
      return [item.payload.message, item.payload.error, item.payload.reason]
        .filter((value) => typeof value === "string" && value)
        .join("\n");
    }
  }

  if (item.type === "error" && item.payload) {
    if (typeof item.payload === "string") {
      return item.payload;
    }
    return [item.payload.message, item.payload.error, item.payload.reason]
      .filter((value) => typeof value === "string" && value)
      .join("\n");
  }

  return null;
}

export function sessionIdFromTranscriptPath(transcriptPath) {
  const name = path.basename(transcriptPath);
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : null;
}

export function parseTranscriptMeta(transcriptPath) {
  const text = fs.readFileSync(transcriptPath, "utf8");
  const lines = text.split(/\r?\n/);
  const meta = {
    sessionId: sessionIdFromTranscriptPath(transcriptPath),
    transcriptPath,
    cwd: null,
    model: null,
    approvalPolicy: null,
    sandboxType: null
  };

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }

    if (item.type === "session_meta" && item.payload) {
      meta.sessionId = item.payload.id ?? meta.sessionId;
      meta.cwd = item.payload.cwd ?? meta.cwd;
      meta.model = item.payload.model ?? meta.model;
    }

    if (item.type === "turn_context" && item.payload) {
      meta.cwd = item.payload.cwd ?? meta.cwd;
      meta.model = item.payload.model ?? meta.model;
      meta.approvalPolicy = item.payload.approval_policy ?? meta.approvalPolicy;
      meta.sandboxType = item.payload.sandbox_policy?.type ?? meta.sandboxType;
    }
  }

  return meta;
}

export function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { version: 1, sessions: {} };
  }
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return {
      version: 1,
      sessions: state.sessions && typeof state.sessions === "object" ? state.sessions : {}
    };
  } catch {
    return { version: 1, sessions: {} };
  }
}

export function saveState(state) {
  saveJsonAtomic(STATE_PATH, {
    version: 1,
    sessions: state.sessions ?? {}
  });
}

export function enableSession({ transcriptPath, sessionId, model, cwd, fallbackModel } = {}) {
  const resolvedTranscript = transcriptPath
    ? path.resolve(transcriptPath)
    : sessionId
      ? findTranscriptBySessionId(sessionId)
      : findLatestTranscript({ cwd });

  if (!resolvedTranscript) {
    throw new Error("No Codex transcript found to enable");
  }

  const meta = parseTranscriptMeta(resolvedTranscript);
  const resolvedSessionId = sessionId ?? meta.sessionId;
  if (!resolvedSessionId) {
    throw new Error(`Could not determine session id for ${resolvedTranscript}`);
  }

  const stat = fs.statSync(resolvedTranscript);
  const state = loadState();
  const now = new Date().toISOString();
  state.sessions[resolvedSessionId] = {
    ...(state.sessions[resolvedSessionId] ?? {}),
    enabled: true,
    sessionId: resolvedSessionId,
    transcriptPath: resolvedTranscript,
    cwd: cwd ?? meta.cwd ?? null,
    originalModel: model ?? meta.model ?? null,
    fallbackModel: fallbackModel ?? DEFAULT_FALLBACK_MODEL,
    approvalPolicy: meta.approvalPolicy ?? null,
    sandboxType: meta.sandboxType ?? null,
    lastScannedSize: stat.size,
    rescueInProgress: false,
    lastHandledFingerprint: state.sessions[resolvedSessionId]?.lastHandledFingerprint ?? null,
    createdAt: state.sessions[resolvedSessionId]?.createdAt ?? now,
    updatedAt: now
  };
  saveState(state);

  return state.sessions[resolvedSessionId];
}

export function disableSession({ sessionId, latest = false, all = false } = {}) {
  const state = loadState();
  if (all) {
    for (const session of Object.values(state.sessions)) {
      session.enabled = false;
      session.updatedAt = new Date().toISOString();
    }
    saveState(state);
    return Object.values(state.sessions);
  }

  const resolvedSessionId = sessionId ?? (latest ? parseTranscriptMeta(findLatestTranscript()).sessionId : null);
  if (!resolvedSessionId || !state.sessions[resolvedSessionId]) {
    return null;
  }

  state.sessions[resolvedSessionId].enabled = false;
  state.sessions[resolvedSessionId].updatedAt = new Date().toISOString();
  saveState(state);
  return state.sessions[resolvedSessionId];
}

export async function scanSessionOnce(session, options = {}) {
  if (!session.enabled || session.rescueInProgress || !session.transcriptPath) {
    return { changed: false, rescued: false };
  }

  if (session.pendingFailure && pendingRetryDue(session)) {
    await rescueSession(session, session.pendingFailure, options);
    return { changed: true, rescued: true };
  }

  if (!fs.existsSync(session.transcriptPath)) {
    logEvent("session_transcript_missing", { sessionId: session.sessionId, transcriptPath: session.transcriptPath });
    return { changed: false, rescued: false };
  }

  const stat = fs.statSync(session.transcriptPath);
  const start = Math.max(0, Math.min(Number(session.lastScannedSize ?? 0), stat.size));
  if (stat.size <= start) {
    return { changed: false, rescued: false };
  }

  const segment = readFileRange(session.transcriptPath, start, stat.size);
  const lastNewline = segment.lastIndexOf("\n");
  if (lastNewline < 0) {
    return { changed: false, rescued: false };
  }

  const complete = segment.slice(0, lastNewline + 1);
  const nextOffset = start + Buffer.byteLength(complete, "utf8");
  const lines = complete.split(/\r?\n/).filter(Boolean);
  let failure = null;
  let bytePosition = start;

  for (const line of lines) {
    updateSessionFromTranscriptLine(session, line);
    if (!failure && detectCompactFailureLine(line)) {
      failure = {
        fingerprint: `${session.sessionId}:${bytePosition}:${hashText(line)}`,
        line
      };
    }
    bytePosition += Buffer.byteLength(line, "utf8") + 1;
  }

  session.lastScannedSize = nextOffset;
  session.updatedAt = new Date().toISOString();

  if (!failure || failure.fingerprint === session.lastHandledFingerprint) {
    return { changed: true, rescued: false };
  }

  await rescueSession(session, failure, options);
  return { changed: true, rescued: true };
}

export async function rescueSession(session, failure, options = {}) {
  const state = loadState();
  const current = state.sessions[session.sessionId] ?? session;
  if (current.rescueInProgress || !current.enabled) {
    return;
  }

  current.rescueInProgress = true;
  current.lastFailureFingerprint = failure.fingerprint;
  current.pendingFailure = failure;
  current.lastScannedSize = Number.isFinite(Number(session.lastScannedSize)) ? session.lastScannedSize : current.lastScannedSize;
  current.lastRescueAttemptAt = new Date().toISOString();
  delete current.nextRetryAt;
  current.updatedAt = new Date().toISOString();
  state.sessions[session.sessionId] = current;
  saveState(state);

  logEvent("rescue_started", {
    sessionId: current.sessionId,
    originalModel: current.originalModel,
    fallbackModel: current.fallbackModel ?? DEFAULT_FALLBACK_MODEL
  });

  try {
    await waitForTranscriptQuiet(
      current.transcriptPath,
      options.quietMs ?? Number(process.env.CODEX_RESCUE_QUIET_MS ?? DEFAULT_QUIET_MS),
      options.maxSettleMs ?? Number(process.env.CODEX_RESCUE_MAX_SETTLE_MS ?? DEFAULT_MAX_SETTLE_MS)
    );

    const fallbackResult = await runCodexResume(current, current.fallbackModel ?? DEFAULT_FALLBACK_MODEL, DEFAULT_FALLBACK_PROMPT, options);
    if (fallbackResult.exitCode !== 0) {
      throw new Error(`fallback resume failed with exit ${fallbackResult.exitCode}`);
    }

    const restoreModel = current.originalModel ?? current.fallbackModel ?? DEFAULT_FALLBACK_MODEL;
    const restoreResult = await runCodexResume(current, restoreModel, DEFAULT_RESTORE_PROMPT, options);
    if (restoreResult.exitCode !== 0) {
      throw new Error(`restore resume failed with exit ${restoreResult.exitCode}`);
    }

    const finalState = loadState();
    const finalSession = finalState.sessions[current.sessionId] ?? current;
    finalSession.rescueInProgress = false;
    finalSession.lastHandledFingerprint = failure.fingerprint;
    delete finalSession.pendingFailure;
    delete finalSession.nextRetryAt;
    delete finalSession.lastRescueError;
    finalSession.lastRescueAt = new Date().toISOString();
    finalSession.lastScannedSize = fs.existsSync(finalSession.transcriptPath)
      ? fs.statSync(finalSession.transcriptPath).size
      : finalSession.lastScannedSize;
    finalSession.updatedAt = new Date().toISOString();
    finalState.sessions[current.sessionId] = finalSession;
    saveState(finalState);
    logEvent("rescue_completed", { sessionId: current.sessionId, restoreModel });
  } catch (error) {
    const errorState = loadState();
    const errorSession = errorState.sessions[current.sessionId] ?? current;
    errorSession.rescueInProgress = false;
    errorSession.pendingFailure = failure;
    errorSession.lastRescueError = publicError(error);
    errorSession.nextRetryAt = new Date(Date.now() + retryCooldownMs(options)).toISOString();
    errorSession.updatedAt = new Date().toISOString();
    errorState.sessions[current.sessionId] = errorSession;
    saveState(errorState);
    logEvent("rescue_failed", { sessionId: current.sessionId, error: publicError(error) });
  }
}

export async function watch(options = {}) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  writeWatcherPid();
  process.once("exit", clearWatcherPid);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      clearWatcherPid();
      process.exit(0);
    });
  }
  logEvent("watcher_started", { pid: process.pid });

  while (true) {
    const state = loadState();
    let changed = false;
    let rescued = false;
    for (const session of Object.values(state.sessions)) {
      const result = await scanSessionOnce(session, options);
      changed = changed || result.changed;
      rescued = rescued || result.rescued;
    }

    if (changed && !rescued) {
      saveState(state);
    }

    if (options.once) {
      return;
    }
    await sleep(options.pollMs ?? Number(process.env.CODEX_RESCUE_POLL_MS ?? DEFAULT_POLL_MS));
  }
}

export async function runCodexResume(session, model, prompt, options = {}) {
  if (options.dryRun || process.env.CODEX_RESCUE_DRY_RUN === "1") {
    appendJsonLine(DRY_RUN_PATH, {
      time: new Date().toISOString(),
      sessionId: session.sessionId,
      model,
      prompt
    });
    logEvent("resume_dry_run", { sessionId: session.sessionId, model });
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  const codexBin = options.codexBin ?? process.env.CODEX_RESCUE_CODEX_BIN ?? findCodexBin();
  const args = buildResumeArgs(session, model, prompt);
  logEvent("resume_started", { sessionId: session.sessionId, model });

  return await runProcess(codexBin, args, {
    cwd: session.cwd && fs.existsSync(session.cwd) ? session.cwd : process.cwd(),
    timeoutMs: options.resumeTimeoutMs ?? Number(process.env.CODEX_RESCUE_RESUME_TIMEOUT_MS ?? DEFAULT_RESUME_TIMEOUT_MS)
  });
}

export function buildResumeArgs(session, model, prompt) {
  const args = [];
  if (session.approvalPolicy === "never") {
    args.push("-a", "never");
  }
  if (session.sandboxType === "danger-full-access" || session.sandboxType === "workspace-write" || session.sandboxType === "read-only") {
    args.push("-s", session.sandboxType);
  }
  if (session.cwd) {
    args.push("-C", session.cwd);
  }
  args.push("exec", "resume", "--skip-git-repo-check", "-m", model, session.sessionId, prompt);
  return args;
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  switch (command) {
    case "enable": {
      const session = enableSession({
        transcriptPath: options.transcript,
        sessionId: options.sessionId,
        model: options.model,
        cwd: options.cwd,
        fallbackModel: options.fallbackModel
      });
      console.log(JSON.stringify({ ok: true, enabled: session }, null, 2));
      break;
    }
    case "disable": {
      const disabled = disableSession({
        sessionId: options.sessionId,
        latest: Boolean(options.latest),
        all: Boolean(options.all)
      });
      console.log(JSON.stringify({ ok: true, disabled }, null, 2));
      break;
    }
    case "status": {
      const state = loadState();
      const watcher = readWatcherStatus();
      console.log(JSON.stringify({
        ok: true,
        watcherPid: watcher.pid,
        watcherRunning: watcher.running,
        watcherPidPath: WATCHER_PID_PATH,
        statePath: STATE_PATH,
        sessions: Object.values(state.sessions)
      }, null, 2));
      break;
    }
    case "watch":
      await watch();
      break;
    case "once":
      await watch({ once: true });
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function updateSessionFromTranscriptLine(session, line) {
  let item;
  try {
    item = JSON.parse(line);
  } catch {
    return;
  }
  if (item.type !== "turn_context" || !item.payload) {
    return;
  }

  session.cwd = item.payload.cwd ?? session.cwd;
  session.approvalPolicy = item.payload.approval_policy ?? session.approvalPolicy;
  session.sandboxType = item.payload.sandbox_policy?.type ?? session.sandboxType;

  const model = item.payload.model;
  if (model && model !== (session.fallbackModel ?? DEFAULT_FALLBACK_MODEL)) {
    session.originalModel = model;
  }
}

function findCodexBin() {
  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    collectCodexBins(path.join(localAppData, "OpenAI", "Codex", "bin"), candidates, 0);
  }

  const pathCandidates = String(process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => path.join(entry, process.platform === "win32" ? "codex.exe" : "codex"))
    .filter((candidate) => fs.existsSync(candidate));
  candidates.push(...pathCandidates.map((candidate) => ({ path: candidate, mtimeMs: fs.statSync(candidate).mtimeMs, priority: 1 })));

  candidates.sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1) || b.mtimeMs - a.mtimeMs);
  if (!candidates[0]) {
    throw new Error("Could not find codex executable");
  }
  return candidates[0].path;
}

function collectCodexBins(root, out, priority = 1) {
  if (!fs.existsSync(root)) {
    return;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectCodexBins(fullPath, out, priority);
    } else if (entry.isFile() && entry.name.toLowerCase() === (process.platform === "win32" ? "codex.exe" : "codex")) {
      const stat = fs.statSync(fullPath);
      out.push({ path: fullPath, mtimeMs: stat.mtimeMs, priority });
    }
  }
}

function findLatestTranscript({ cwd } = {}) {
  const sessionsRoot = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
  const transcripts = [];
  collectTranscripts(sessionsRoot, transcripts);
  transcripts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (cwd) {
    const normalizedCwd = normalizePathForCompare(cwd);
    const match = transcripts.find((item) => {
      try {
        return normalizePathForCompare(parseTranscriptMeta(item.path).cwd) === normalizedCwd;
      } catch {
        return false;
      }
    });
    if (match) {
      return match.path;
    }
  }
  return transcripts[0]?.path ?? null;
}

function findTranscriptBySessionId(sessionId) {
  const sessionsRoot = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
  const transcripts = [];
  collectTranscripts(sessionsRoot, transcripts);
  return transcripts.find((item) => item.path.includes(sessionId))?.path ?? null;
}

function collectTranscripts(root, out) {
  if (!root || !fs.existsSync(root)) {
    return;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectTranscripts(fullPath, out);
    } else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
      const stat = fs.statSync(fullPath);
      out.push({ path: fullPath, mtimeMs: stat.mtimeMs });
    }
  }
}

function readFileRange(file, start, end) {
  const length = end - start;
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function waitForTranscriptQuiet(file, quietMs, maxMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let lastSize = fs.existsSync(file) ? fs.statSync(file).size : 0;
    let lastChange = Date.now();

    const timer = setInterval(() => {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size !== lastSize) {
        lastSize = size;
        lastChange = Date.now();
      }
      if (Date.now() - lastChange >= quietMs || Date.now() - started >= maxMs) {
        clearInterval(timer);
        resolve();
      }
    }, 500);
  });
}

function runProcess(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      stdout = trimCapture(stdout + chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderr = trimCapture(stderr + chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${publicError(error)}` });
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      const exitCode = timedOut ? 124 : (code ?? 1);
      logEvent("resume_finished", {
        exitCode,
        stdoutTail: stdout.slice(-1000),
        stderrTail: stderr.slice(-1000)
      });
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function parseArgs(argv) {
  const command = argv[0] ?? "status";
  const options = {};
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = toCamelCase(arg.slice(2));
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = true;
    }
  }
  return { command, options };
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function saveJsonAtomic(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function appendJsonLine(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
}

function logEvent(event, payload = {}) {
  appendJsonLine(LOG_PATH, {
    time: new Date().toISOString(),
    event,
    ...payload
  });
}

function retryCooldownMs(options = {}) {
  return options.retryCooldownMs ?? Number(process.env.CODEX_RESCUE_RETRY_COOLDOWN_MS ?? DEFAULT_RETRY_COOLDOWN_MS);
}

function pendingRetryDue(session) {
  const retryAt = Date.parse(session.nextRetryAt ?? "");
  return !Number.isFinite(retryAt) || Date.now() >= retryAt;
}

function writeWatcherPid() {
  fs.mkdirSync(path.dirname(WATCHER_PID_PATH), { recursive: true });
  fs.writeFileSync(WATCHER_PID_PATH, `${process.pid}\n`, "utf8");
}

function clearWatcherPid() {
  try {
    const pid = Number(fs.readFileSync(WATCHER_PID_PATH, "utf8").trim());
    if (pid === process.pid) {
      fs.unlinkSync(WATCHER_PID_PATH);
    }
  } catch {
    // Best effort cleanup only.
  }
}

function readWatcherStatus() {
  let pid = null;
  try {
    pid = Number(fs.readFileSync(WATCHER_PID_PATH, "utf8").trim());
  } catch {
    return { pid: null, running: false };
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    return { pid: null, running: false };
  }

  return { pid, running: processExists(pid) };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function publicError(error) {
  return String(error?.message ?? error).slice(0, 500);
}

function trimCapture(value) {
  return value.length > 8000 ? value.slice(-8000) : value;
}

function normalizePathForCompare(value) {
  return value ? path.resolve(value).toLowerCase() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(SCRIPT_PATH)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(publicError(error));
    process.exitCode = 1;
  });
}
