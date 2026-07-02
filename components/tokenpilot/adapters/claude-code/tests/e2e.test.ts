import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  assertProductSurfaceSmoke,
  assertRecoveryProtocolText,
  assertRecoveryRoundTrip,
  assertReductionMarkerText,
  assertStablePrefixRewrite,
  createLongToolPayload,
  reserveUnusedPort,
  withTempHome,
  type HostGatewayForwarder,
} from "@tokenpilot/host-adapter";
import { MEMORY_FAULT_RECOVER_TOOL_NAME, handleMcpRequest } from "../../../products/mcp/src/index.js";
import {
  defaultTokenPilotClaudeCodeConfigPath,
  loadTokenPilotClaudeCodeConfig,
  normalizeTokenPilotClaudeCodeConfig,
  writeTokenPilotClaudeCodeConfig,
} from "../src/config.js";
import { startClaudeCodeGatewayRuntime } from "../src/gateway-runtime.js";
import { installClaudeCodeTokenPilot } from "../src/install.js";
import { createConsoleLogger } from "../src/logger.js";
import { createClaudeCodeCliBridge } from "../../../products/cli/src/hosts/claude-code.js";

function extractToolResultText(block: Record<string, unknown> | undefined): string {
  if (!block) return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  return "";
}

test("Claude Code host e2e wires install, gateway reduction, report/visual, and MCP recovery together", async () => {
  await withTempHome("lightmem2-claude-e2e-", async (homeDir) => {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".claude", "tokenpilot-state", "tokenpilot");
    const configPath = defaultTokenPilotClaudeCodeConfigPath();
    const seenPayloads: Array<Record<string, unknown>> = [];
    const longToolPayload = createLongToolPayload();
    const forwarder: HostGatewayForwarder = {
      async request(params) {
        seenPayloads.push(params.payload as Record<string, unknown>);
        return {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
          text: JSON.stringify({
            id: "msg_e2e_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            usage: { input_tokens: 32, output_tokens: 6 },
            stop_reason: "end_turn",
          }),
        };
      },
      async requestStream() {
        throw new Error("stream path should not be used in this test");
      },
    };

    let runtime: Awaited<ReturnType<typeof startClaudeCodeGatewayRuntime>> | undefined;
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeTokenPilotClaudeCodeConfig(
      normalizeTokenPilotClaudeCodeConfig({
        proxyPort,
        stateDir,
        hooks: {
          dynamicContextTarget: "user",
        },
        reduction: {
          triggerMinChars: 256,
          maxToolChars: 280,
          passes: {
            readStateCompaction: false,
            toolPayloadTrim: true,
            htmlSlimming: false,
            execOutputTruncation: true,
            agentsStartupOptimization: false,
          },
        },
      }),
      configPath,
    );

    const installResult = await installClaudeCodeTokenPilot();
    assert.equal(installResult.tokenPilotConfigPath, configPath);
    assert.equal(installResult.stateDir, stateDir);

    const config = await loadTokenPilotClaudeCodeConfig(configPath);
    runtime = await startClaudeCodeGatewayRuntime({
      config,
      logger: createConsoleLogger(false),
      forwarder,
    });

    const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-e2e-1",
      },
      body: JSON.stringify({
        model: "tokenpilot/claude-sonnet-4-6",
        stream: false,
        system: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize this tool output" },
              { type: "tool_result", tool_use_id: "toolu_1", content: longToolPayload },
            ],
          },
        ],
        max_tokens: 256,
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(seenPayloads.length, 1);
    assert.equal(seenPayloads[0]?.model, "claude-sonnet-4-6");
    const forwardedMessages = seenPayloads[0]?.messages as Array<Record<string, unknown>>;
    const forwardedBlocks = forwardedMessages?.[0]?.content as Array<Record<string, unknown>>;
    assertStablePrefixRewrite({
      sanitizedPromptText: String(seenPayloads[0]?.system ?? ""),
      dynamicContextText: String(forwardedBlocks?.[0]?.text ?? ""),
      workdir: "/repo/demo",
      agentId: "agent-123",
    });
    assert.match(String(seenPayloads[0]?.system ?? ""), /Be precise\./);
    assertRecoveryProtocolText(String(seenPayloads[0]?.system ?? ""));

    const reducedToolText = extractToolResultText(forwardedBlocks?.[1]);
    assertReductionMarkerText(reducedToolText);
    await assertRecoveryRoundTrip({
      reducedText: reducedToolText,
      stateDir,
      async recover(dataKey) {
        const recovery = await handleMcpRequest(
          {
            id: 1,
            method: "tools/call",
            params: {
              name: MEMORY_FAULT_RECOVER_TOOL_NAME,
              arguments: {
                dataKey,
              },
            },
          },
          { stateDir },
        );
        const recoveryContent = recovery?.result?.content as Array<{ type: string; text: string }>;
        return {
          isError: recovery?.result?.isError === true,
          text: recoveryContent?.[0]?.text ?? "",
        };
      },
    });

    const { handleCommand } = createClaudeCodeCliBridge({ host: "claude-code" });

    await assertProductSurfaceSmoke({
      run(args) {
        return handleCommand({ args });
      },
      doctorPatterns: [
        /TokenPilot Claude Code doctor:/,
        /settings installed: yes/,
        /observability hooks installed: yes/,
        /observability hooks complete: yes/,
        /recovery MCP installed: yes/,
        /recovery MCP stateDir matches: yes/,
        /routed via gateway: yes/,
        /tool search enabled: yes/,
        /proxy healthy: yes/,
        /session state available: yes/,
        /ux effects available: yes/,
      ],
      report: {
        sessionId: "sess-e2e-1",
        unitLabel: "chars",
        optimizedTurns: 1,
      },
      visual: {
        header: "LightMem2 visual:",
        sessionId: "sess-e2e-1",
        requiredPatterns: [
          /host=claude-code/,
          /session=sess-e2e-1/,
          /Claude Code: 1 session snapshots/,
        ],
      },
    });

    await runtime?.close();
  });
});

test("Claude Code CLI report and visual return clear empty-state messages before any runtime data exists", async () => {
  await withTempHome("lightmem2-claude-cli-empty-state-", async (homeDir) => {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".claude", "tokenpilot-state", "tokenpilot");
    const configPath = defaultTokenPilotClaudeCodeConfigPath();

    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeTokenPilotClaudeCodeConfig(
      normalizeTokenPilotClaudeCodeConfig({
        proxyPort,
        stateDir,
      }),
      configPath,
    );

    const { handleCommand } = createClaudeCodeCliBridge({ host: "claude-code" });

    const report = await handleCommand({ args: "report" });
    assert.equal(report.text, "No TokenPilot session stats yet.");

    const visual = await handleCommand({ args: "visual" });
    assert.match(visual.text, /LightMem2 visual: http:\/\/127\.0\.0\.1:/);
    assert.match(visual.text, /host=claude-code/);
  });
});
