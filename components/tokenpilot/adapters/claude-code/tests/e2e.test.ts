import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HostGatewayForwarder } from "@tokenpilot/host-adapter";
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

async function reserveUnusedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to reserve test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function extractToolResultText(block: Record<string, unknown> | undefined): string {
  if (!block) return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  return "";
}

test("Claude Code host e2e wires install, gateway reduction, report/visual, and MCP recovery together", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "lightmem2-claude-e2e-"));
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  const proxyPort = await reserveUnusedPort();
  const stateDir = join(homeDir, ".claude", "tokenpilot-state", "tokenpilot");
  const configPath = defaultTokenPilotClaudeCodeConfigPath();
  const seenPayloads: Array<Record<string, unknown>> = [];
  const longToolPayload = `payload\n${"line\n".repeat(900)}`;
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
  try {
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
    assert.match(String(seenPayloads[0]?.system ?? ""), /^Your working directory is: <WORKDIR>\nRuntime: agent=<AGENT_ID> \|\nBe precise\./);
    assert.match(String(seenPayloads[0]?.system ?? ""), /\[Recovery Protocol\]/);

    const forwardedMessages = seenPayloads[0]?.messages as Array<Record<string, unknown>>;
    const forwardedBlocks = forwardedMessages?.[0]?.content as Array<Record<string, unknown>>;
    assert.match(String(forwardedBlocks?.[0]?.text ?? ""), /WORKDIR: \/repo\/demo/);
    assert.match(String(forwardedBlocks?.[0]?.text ?? ""), /AGENT_ID: agent-123/);

    const reducedToolText = extractToolResultText(forwardedBlocks?.[1]);
    assert.match(reducedToolText, /\[Tool payload trimmed\]|\[Exec output truncated\]/);
    const dataKeyMatch = reducedToolText.match(/memory_fault_recover with \{"dataKey":"([^"]+)"\}/);
    assert.ok(dataKeyMatch);

    const archiveRoot = join(stateDir, "tokenpilot", "tool-result-archives");
    const sessions = await readdir(archiveRoot, { withFileTypes: true }).catch(() => []);

    const recovery = await handleMcpRequest(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: MEMORY_FAULT_RECOVER_TOOL_NAME,
          arguments: {
            dataKey: dataKeyMatch?.[1] ?? "",
          },
        },
      },
      { stateDir },
    );
    const recoveryContent = recovery?.result?.content as Array<{ type: string; text: string }>;
    assert.equal(
      recovery?.result?.isError,
      false,
      `recovery failed for dataKey=${dataKeyMatch?.[1] ?? ""}; archiveSessions=${sessions.map((entry) => entry.name).join(",")}; message=${recoveryContent?.[0]?.text ?? ""}`,
    );
    assert.match(recoveryContent[0]?.text ?? "", /Recovered content for:/);
    assert.match(recoveryContent[0]?.text ?? "", /payload/);
    assert.match(recoveryContent[0]?.text ?? "", /line/);

    const { handleCommand } = createClaudeCodeCliBridge({ host: "claude-code" });

    const doctor = await handleCommand({ args: "doctor" });
    assert.match(doctor.text, /TokenPilot Claude Code doctor:/);
    assert.match(doctor.text, /settings installed: yes/);
    assert.match(doctor.text, /recovery MCP installed: yes/);
    assert.match(doctor.text, /recovery MCP stateDir matches: yes/);
    assert.match(doctor.text, /routed via gateway: yes/);
    assert.match(doctor.text, /tool search enabled: yes/);
    assert.match(doctor.text, /proxy healthy: yes/);
    assert.match(doctor.text, /session state available: yes/);
    assert.match(doctor.text, /ux effects available: yes/);

    const report = await handleCommand({ args: "report" });
    assert.match(report.text, /TokenPilot report:/);
    assert.match(report.text, /session: sess-e2e-1/);
    assert.match(report.text, /saved chars:/);
    assert.match(report.text, /optimized turns: 1/);

    const visual = await handleCommand({ args: "visual" });
    assert.match(visual.text, /TokenPilot Claude Code visual:/);
    assert.match(visual.text, /session: sess-e2e-1/);
    assert.match(visual.text, /workspace: \/repo\/demo/);
    assert.match(visual.text, /latest response: msg_e2e_1/);
    assert.match(visual.text, /latest reduction savings:/);
  } finally {
    await runtime?.close();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true });
  }
});
