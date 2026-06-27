/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import { mkdir } from "node:fs/promises";
import {
  createStaticStatePathResolver,
  prepareBeforeCall,
  createSseJsonStreamObserver,
  type HostGatewayForwarder,
  type HostGatewayStreamObserver,
} from "@tokenpilot/host-adapter";
import { configureStatePathResolver } from "@tokenpilot/runtime-core";
import type { TokenPilotClaudeCodeConfig } from "./config.js";
import { proxyBaseUrlForPort } from "./config.js";
import type { TokenPilotClaudeCodeLogger } from "./logger.js";
import { createClaudeMessagesPayloadCodec } from "./messages-codec.js";
import { reduceClaudeRequestEnvelope, type ClaudeReductionSummary } from "./reduction.js";
import {
  appendClaudeCodeRecentTurnBinding,
  upsertClaudeCodeSessionSnapshot,
} from "./session-state.js";
import { prepareClaudeStablePrefix } from "./stable-prefix.js";
import { appendClaudeCodeTrace } from "./trace.js";
import { defaultClaudeCodeGatewayForwarder, resolveClaudeCodeUpstream } from "./upstream.js";
import { recordClaudeCodeUxEffect } from "./ux-effects.js";

export type ClaudeCodeGatewayRuntime = {
  baseUrl: string;
  close(): Promise<void>;
};

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function setForwardHeaders(
  res: ServerResponse,
  headers: Record<string, string>,
  fallbackContentType: string,
): void {
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "content-length" || lower === "content-encoding") continue;
    if (typeof value === "string" && value) res.setHeader(key, value);
  }
  if (!res.hasHeader("content-type")) res.setHeader("content-type", fallbackContentType);
}

function extractWorkspaceHint(envelope: {
  instructions?: string;
  metadata?: Record<string, unknown>;
}): string | undefined {
  const metadataHint = typeof envelope.metadata?.workspaceHint === "string"
    ? envelope.metadata.workspaceHint.trim()
    : "";
  if (metadataHint) return metadataHint;
  const instructions = typeof envelope.instructions === "string" ? envelope.instructions : "";
  const match = instructions.match(/Your working directory is:\s*(.+)/);
  const raw = match?.[1]?.trim() ?? "";
  return raw && raw !== "<WORKDIR>" ? raw : undefined;
}

async function recordClaudeGatewayTurn(params: {
  stateDir: string;
  sessionId: string;
  model: string;
  responseId?: string;
  previousResponseId?: string;
  requestChars: number;
  responseChars: number;
  assistantChars: number;
  reductionSavedChars: number;
  stablePrefixApplied: boolean;
  reductionApplied: boolean;
  stream: boolean;
  workspaceHint?: string;
}): Promise<void> {
  const updatedAt = new Date().toISOString();
  await upsertClaudeCodeSessionSnapshot(params.stateDir, params.sessionId, {
    latestResponseId: params.responseId,
    previousResponseId: params.previousResponseId,
    latestModel: params.model,
    workspaceHint: params.workspaceHint,
    requestChars: params.requestChars,
    responseChars: params.responseChars,
    assistantChars: params.assistantChars,
    reductionSavedChars: params.reductionSavedChars,
  });
  await appendClaudeCodeRecentTurnBinding(params.stateDir, {
    sessionId: params.sessionId,
    responseId: params.responseId,
    previousResponseId: params.previousResponseId,
    model: params.model,
    requestChars: params.requestChars,
    responseChars: params.responseChars,
    assistantChars: params.assistantChars,
    reductionSavedChars: params.reductionSavedChars,
    stablePrefixApplied: params.stablePrefixApplied,
    reductionApplied: params.reductionApplied,
    stream: params.stream,
    updatedAt,
  });
  if (params.reductionSavedChars > 0) {
    await recordClaudeCodeUxEffect(params.stateDir, {
      at: updatedAt,
      sessionId: params.sessionId,
      model: params.model,
      countMode: "chars",
      beforeCount: params.requestChars,
      afterCount: Math.max(0, params.requestChars - params.reductionSavedChars),
      savedCount: params.reductionSavedChars,
      details: {
        requestSavedCount: params.reductionSavedChars,
      },
    });
  }
}

export async function startClaudeCodeGatewayRuntime(params: {
  config: TokenPilotClaudeCodeConfig;
  logger: TokenPilotClaudeCodeLogger;
  forwarder?: HostGatewayForwarder;
  streamObserver?: HostGatewayStreamObserver;
}): Promise<ClaudeCodeGatewayRuntime> {
  const { config, logger } = params;
  if (!config.enabled) {
    throw new Error("TokenPilot Claude Code adapter is disabled by config");
  }

  configureStatePathResolver(createStaticStatePathResolver({
    hostId: "claude-code",
    displayName: "Claude Code",
    stateDir: config.stateDir,
    namespaceDir: "tokenpilot",
  }));

  await mkdir(config.stateDir, { recursive: true });
  const upstream = resolveClaudeCodeUpstream(config);
  const codec = createClaudeMessagesPayloadCodec();
  const forwarder = params.forwarder ?? defaultClaudeCodeGatewayForwarder;
  const streamObserver = params.streamObserver ?? createSseJsonStreamObserver({
    responseIdPaths: [["message", "id"], ["id"]],
    usagePaths: [["usage"]],
  });

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, {
          ok: true,
          adapter: "tokenpilot-claude-code",
          upstream: upstream.baseUrl,
          stateDir: config.stateDir,
        });
        return;
      }

      if (req.method !== "POST" || req.url !== "/v1/messages") {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      const body = await readRequestBody(req);
      let payload = JSON.parse(body);
      let envelope = codec.decodeRequest(payload, {
        headers: req.headers as Record<string, string | string[] | undefined>,
      });
      if (envelope.model.startsWith("tokenpilot/")) {
        envelope = {
          ...envelope,
          model: envelope.model.slice("tokenpilot/".length),
        };
      }
      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const sessionId = envelope.session.sessionId;
      const workspaceHint = extractWorkspaceHint(envelope);
      let reductionSummary: ClaudeReductionSummary | undefined;
      const prepared = await prepareBeforeCall({
        envelope,
        config: { mode: "normal" },
        helpers: {
          prepareStablePrefix(nextEnvelope) {
            return prepareClaudeStablePrefix(nextEnvelope, config);
          },
          async applyBeforeCallReduction(nextEnvelope) {
            const reduced = await reduceClaudeRequestEnvelope({
              envelope: nextEnvelope,
              codec,
              config,
            });
            reductionSummary = reduced.summary;
            return reduced.envelope;
          },
        },
      });
      payload = codec.encodeRequest(prepared.envelope);

      await appendClaudeCodeTrace(config.stateDir, {
        stage: "gateway_before_call",
        sessionId,
        model: prepared.envelope.model,
        stream: prepared.envelope.stream,
        requestChars: body.length,
        stablePrefixApplied: prepared.diagnostics.stablePrefixApplied === true,
        reductionApplied: prepared.diagnostics.reductionApplied === true,
        reductionSavedChars: reductionSummary?.savedChars ?? 0,
        reductionChangedBlocks: reductionSummary?.changedBlocks ?? 0,
        reductionChangedMessages: reductionSummary?.changedMessages ?? 0,
        reductionSkippedReason: reductionSummary?.skippedReason ?? null,
        reductionPassEffects: reductionSummary?.passEffects ?? [],
      });

      if (prepared.envelope.stream) {
        const upstreamResp = await forwarder.requestStream({
          upstream,
          payload,
          inboundAuthorization: authorization,
        });
        res.statusCode = upstreamResp.status;
        setForwardHeaders(res, upstreamResp.headers, "text/event-stream; charset=utf-8");
        const chunks: Buffer[] = [];
        upstreamResp.stream.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          chunks.push(buffer);
          res.write(buffer);
        });
        upstreamResp.stream.once("end", async () => {
          const rawStreamText = Buffer.concat(chunks).toString("utf8");
          const snapshot = streamObserver.snapshot(rawStreamText);
          const responseId = typeof snapshot.metadata?.responseId === "string" ? snapshot.metadata.responseId : undefined;
          const previousResponseId =
            typeof snapshot.metadata?.previousResponseId === "string" ? snapshot.metadata.previousResponseId : undefined;
          await appendClaudeCodeTrace(config.stateDir, {
            stage: "gateway_after_call",
            sessionId,
            model: prepared.envelope.model,
            stream: true,
            status: upstreamResp.status,
            assistantChars: snapshot.assistantText.length,
            responseChars: rawStreamText.length,
          });
          await recordClaudeGatewayTurn({
            stateDir: config.stateDir,
            sessionId,
            model: prepared.envelope.model,
            responseId,
            previousResponseId,
            requestChars: body.length,
            responseChars: rawStreamText.length,
            assistantChars: snapshot.assistantText.length,
            reductionSavedChars: reductionSummary?.savedChars ?? 0,
            stablePrefixApplied: prepared.diagnostics.stablePrefixApplied === true,
            reductionApplied: prepared.diagnostics.reductionApplied === true,
            stream: true,
            workspaceHint,
          });
          res.end();
        });
        upstreamResp.stream.once("error", (error) => {
          logger.error(error instanceof Error ? error.message : String(error));
          void appendClaudeCodeTrace(config.stateDir, {
            stage: "gateway_after_call",
            sessionId,
            model: prepared.envelope.model,
            stream: true,
            status: upstreamResp.status,
            error: error instanceof Error ? error.message : String(error),
          });
          if (!res.destroyed) {
            res.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        });
        return;
      }

      const upstreamResp = await forwarder.request({
        upstream,
        payload,
        inboundAuthorization: authorization,
      });
      setForwardHeaders(res, upstreamResp.headers, "application/json; charset=utf-8");
      res.statusCode = upstreamResp.status;
      let assistantChars = 0;
      let responseId: string | undefined;
      let previousResponseId: string | undefined;
      try {
        const decoded = codec.decodeResponse(JSON.parse(upstreamResp.text), prepared.envelope);
        assistantChars = decoded.assistantText?.length ?? 0;
        responseId = typeof decoded.metadata?.responseId === "string" ? decoded.metadata.responseId : undefined;
        previousResponseId =
          typeof decoded.metadata?.previousResponseId === "string" ? decoded.metadata.previousResponseId : undefined;
      } catch {
        assistantChars = 0;
      }
      await appendClaudeCodeTrace(config.stateDir, {
        stage: "gateway_after_call",
        sessionId,
        model: prepared.envelope.model,
        stream: false,
        status: upstreamResp.status,
        responseChars: upstreamResp.text.length,
        assistantChars,
      });
      await recordClaudeGatewayTurn({
        stateDir: config.stateDir,
        sessionId,
        model: prepared.envelope.model,
        responseId,
        previousResponseId,
        requestChars: body.length,
        responseChars: upstreamResp.text.length,
        assistantChars,
        reductionSavedChars: reductionSummary?.savedChars ?? 0,
        stablePrefixApplied: prepared.diagnostics.stablePrefixApplied === true,
        reductionApplied: prepared.diagnostics.reductionApplied === true,
        stream: false,
        workspaceHint,
      });
      res.end(upstreamResp.text);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.proxyPort, "127.0.0.1", () => resolve());
  });

  return {
    baseUrl: proxyBaseUrlForPort(config.proxyPort),
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
