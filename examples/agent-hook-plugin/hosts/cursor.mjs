import { readFile } from "node:fs/promises";

import {
  commitAgentSession,
  stableHash,
} from "../../memory-plugin-shared/lib/agent-hook-runtime.mjs";
import {
  extractPartsFromPayload,
  filterCaptureTurns,
  isCaptureEnabled,
  shapeCaptureParts,
} from "../../memory-plugin-shared/lib/capture-utils.mjs";
import { sendSessionMessages } from "../../memory-plugin-shared/lib/batch-send.mjs";
import { denyCursorPermission, evaluateUriGuard } from "../../memory-plugin-shared/lib/uri-guard.mjs";
import { parseCursorTranscript } from "./cursor-transcript.mjs";

async function readTranscript(ctx) {
  const transcriptPath = ctx.input.transcript_path || ctx.input.transcriptPath;
  if (!transcriptPath) return null;
  try { return parseCursorTranscript(await readFile(transcriptPath, "utf8")); } catch { return null; }
}

async function recordMcpResult(ctx, state) {
  const input = ctx.input;
  // The managed installation registers this exact server key. A tool named
  // "read" on another MCP server must never become an OpenViking read.
  if (input.mcp_server_name !== "openviking") return state;
  if (typeof input.tool_use_id !== "string" || !input.tool_use_id.trim()
    || typeof input.tool_name !== "string" || !input.tool_name.trim()) {
    ctx.log("capture_skip", { reason: "missing_mcp_tool_identity" });
    return state;
  }
  let toolInput, result;
  try {
    toolInput = JSON.parse(input.tool_input);
    result = JSON.parse(input.result_json);
  } catch {
    ctx.log("capture_skip", { reason: "invalid_mcp_tool_json" });
    return state;
  }
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)
    || !result || typeof result !== "object" || Array.isArray(result)) {
    ctx.log("capture_skip", { reason: "invalid_mcp_tool_payload" });
    return state;
  }
  const failed = Boolean(result.isError || result.error || result.rejected || result.permissionDenied);
  if (!failed && !Array.isArray(result.content)) {
    ctx.log("capture_skip", { reason: "missing_mcp_tool_result" });
    return state;
  }
  const hash = `tool:${input.tool_use_id}`;
  const pending = state.pendingToolResults || [];
  if (state.capturedHashes?.includes(hash) || pending.some((item) => item.hash === hash)) return state;
  const parts = shapeCaptureParts(extractPartsFromPayload({
    type: "tool_result",
    tool_use_id: input.tool_use_id,
    name: `mcp__openviking__${input.tool_name}`,
    state: { input: toolInput, output: result },
    is_error: failed,
  }, { toolMaxChars: ctx.cfg.captureToolMaxChars }), "assistant", ctx.cfg).parts;
  // Cursor's text transcript is not a durable source for tool results. Keep
  // them in the existing session state until Stop hands them to the sender.
  // The text position keeps each result next to the conversation that led to it.
  return {
    ...state,
    pendingToolResults: [
      ...pending,
      { hash, afterTurn: (await readTranscript(ctx))?.length ?? null, parts },
    ],
  };
}

async function captureTranscript(ctx, state) {
  const turns = await readTranscript(ctx);
  if (!turns) {
    ctx.log("capture_skip", { reason: "unreadable_transcript" });
    return { state, complete: false };
  }
  const capturedHashes = new Set(Array.isArray(state.capturedHashes) ? state.capturedHashes : []);
  const toSend = [];
  for (const [index, turn] of turns.entries()) {
    // Cursor transcripts do not expose a stable message id. Include the
    // transcript position so two legitimate identical turns are retained,
    // while duplicate Hook executions over the same transcript still dedupe.
    // Hash the raw turn, not the filtered text, so raising captureMaxLength
    // never resends a turn the server already holds in truncated form.
    const hash = stableHash(index, turn.role, turn.content);
    if (capturedHashes.has(hash)) continue;
    const { kept, dropped } = filterCaptureTurns([turn], ctx.cfg);
    if (!kept.length) {
      ctx.log("capture_skip", dropped[0]);
      capturedHashes.add(hash);
      continue;
    }
    toSend.push({ hash, position: index * 2, turn: kept[0] });
  }
  for (const item of state.pendingToolResults || []) {
    if (capturedHashes.has(item.hash)) continue;
    toSend.push({
      hash: item.hash,
      position: (item.afterTurn ?? turns.length) * 2 - 1,
      turn: { role: "assistant", parts: item.parts },
    });
  }
  toSend.sort((a, b) => a.position - b.position);
  // The transcript and pendingToolResults own retries, as Codex's rollout
  // does. Advance only after upload, without a second copy in the offline queue.
  const payloads = toSend.map(({ turn }) => ({
    ...turn,
    ...(ctx.peerId ? { peer_id: ctx.peerId } : {}),
  }));
  const result = await sendSessionMessages(ctx.fetchJSON, ctx.sessionId, payloads);
  const captured = result.sent;
  const acknowledged = toSend.slice(0, captured);
  for (const item of acknowledged) capturedHashes.add(item.hash);
  return {
    captured,
    complete: captured === toSend.length,
    state: {
      ...state,
      capturedHashes: [...capturedHashes].slice(-1000),
      pendingToolResults: (state.pendingToolResults || []).filter((item) => !capturedHashes.has(item.hash)),
      capturedSinceCommit: Number(state.capturedSinceCommit || 0)
        + acknowledged.filter((item) => typeof item.turn.content === "string").length,
    },
  };
}

export const cursor = {
  prefix: "cu-",
  requestBudgets: {
    sessionStart: 25_000,
    beforeSubmitPrompt: 17_000,
    afterMCPExecution: 2_000,
    stop: 25_000,
    preCompact: 25_000,
    sessionEnd: 25_000,
  },
  stages: {
    sessionStart: "start",
    beforeSubmitPrompt: "prompt",
    afterMCPExecution: "capture",
    stop: "capture",
    preCompact: "capture",
    sessionEnd: "capture",
  },
  envelope(event, block) {
    if (event === "beforeSubmitPrompt") {
      return block ? { continue: true, additional_context: block } : { continue: true };
    }
    if (event === "sessionStart" && block) return { additional_context: block };
    return {};
  },
  guard(input = {}) {
    // beforeShellExecution is no longer installed, but a hooks.json from an
    // older install may still route a shell command here, and it must run.
    if (typeof input.command === "string") return {};
    const decision = evaluateUriGuard("read", input);
    return decision ? denyCursorPermission(decision.reason) : {};
  },
  prompt: (input) => (typeof input.prompt === "string" ? input.prompt.trim() : ""),
  async capture(ctx, state, event) {
    if (!isCaptureEnabled(ctx.cfg)) return state;
    if (event === "afterMCPExecution") return recordMcpResult(ctx, state);
    const { state: next, complete } = await captureTranscript(ctx, state);
    if (!complete) return next;
    // Only a plain Stop waits for the threshold: a compaction or a session end
    // is the last chance this transcript has to reach the server.
    const shouldCommit = event !== "stop" || next.capturedSinceCommit >= ctx.cfg.commitTurnThreshold;
    if (shouldCommit) {
      const result = await commitAgentSession(ctx.fetchJSON, ctx.sessionId, ctx.log);
      if (result.ok || result.pendingQueued) next.capturedSinceCommit = 0;
    }
    return next;
  },
};
