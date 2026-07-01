import { installClaudeCodeTokenPilot } from "../src/install.js";

async function main() {
  const result = await installClaudeCodeTokenPilot();
  console.log([
    "TokenPilot Claude Code install complete:",
    `- settings: ${result.settingsPath}`,
    `- settings backup created: ${result.settingsBackedUp ? "yes" : "no"}`,
    `- mcp config: ${result.mcpConfigPath}`,
    `- mcp config backup created: ${result.mcpConfigBackedUp ? "yes" : "no"}`,
    `- tokenpilot config: ${result.tokenPilotConfigPath}`,
    `- state dir: ${result.stateDir}`,
    `- proxy base URL: ${result.proxyBaseUrl}`,
    `- observability hooks installed: ${result.hooksInstalled ? "yes" : "no"}`,
    `- expected hook command: ${result.expectedHookCommand}`,
    `- expected MCP command: ${result.expectedMcpCommand}`,
    `- expected MCP args: ${result.expectedMcpArgs.join(" ")}`,
    `- expected MCP startup timeout: ${result.expectedMcpStartupTimeoutSec}s`,
    `- command skills dir: ${result.commandSkillsDir}`,
    `- command skills: ${result.commandSkillNames.join(", ")}`,
    `- tool search env: ${result.toolSearchEnvName}=${result.toolSearchEnvValue}`,
    `- recovery MCP server: ${result.mcpServerName}`,
    `- recovery MCP probe: ${result.mcpProbe.ok ? "ok" : "degraded"}`,
    `- recovery MCP probe detail: ${result.mcpProbe.detail}`,
  ].join("\n"));
  if (result.mcpProbe.degraded) {
    console.log("MCP recovery is currently degraded. Claude Code gateway routing and reduction remain usable, but `memory_fault_recover` may be unavailable until MCP startup succeeds.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
