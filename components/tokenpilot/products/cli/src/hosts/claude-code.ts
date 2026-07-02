import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  TokenPilotProductSurfaceConfigAdapter,
  TokenPilotProductSurfaceHostBridge,
  readLatestUxEffect,
  readUxSessionAggregate,
} from "@tokenpilot/host-adapter";
import {
  getNestedValue,
  formatDisplayValue,
  formatOnOff,
} from "@tokenpilot/product-surface";
import {
  defaultClaudeCodeMcpConfigPath,
  defaultClaudeCodeSettingsPath,
  defaultTokenPilotClaudeCodeConfigPath,
  loadTokenPilotClaudeCodeConfig,
  normalizeTokenPilotClaudeCodeConfig,
  writeTokenPilotClaudeCodeConfig,
} from "../../../../adapters/claude-code/src/config.js";
import {
  inspectClaudeCodeDoctor,
  formatClaudeCodeDoctorReport,
} from "../../../../adapters/claude-code/src/doctor.js";
import {
  claudeCodeProductSurfaceConfigAdapter,
  resolveClaudeCodeStateDir,
} from "../../../../adapters/claude-code/src/host-config-adapter.js";
import { resolveLatestClaudeCodeSessionId } from "../../../../adapters/claude-code/src/session-state.js";
import {
  applyStandardRuntimeModeConfig,
  buildSessionReportResult,
  createRestrictedHostCommandHandler,
  resolveConfiguredPreferredSessionId,
  resolvePreferredSessionId,
} from "./shared.js";
import { handleStandaloneVisualCommandWithSelection } from "./visual.js";

const CLAUDE_REDUCTION_PASS_NAMES = [
  "readStateCompaction",
  "toolPayloadTrim",
  "htmlSlimming",
  "execOutputTruncation",
  "agentsStartupOptimization",
] as const;

async function loadConfig(): Promise<Record<string, unknown>> {
  return loadTokenPilotClaudeCodeConfig(defaultTokenPilotClaudeCodeConfigPath()) as unknown as Record<string, unknown>;
}

async function writeConfig(nextConfig: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(defaultTokenPilotClaudeCodeConfigPath()), { recursive: true });
  await writeTokenPilotClaudeCodeConfig(
    normalizeTokenPilotClaudeCodeConfig(nextConfig),
    defaultTokenPilotClaudeCodeConfigPath(),
  );
}

async function maybeResolveLatestSessionId(): Promise<string | undefined> {
  return resolveConfiguredPreferredSessionId({
    loadConfig,
    resolveStateDir: resolveClaudeCodeStateDir,
    resolveLatestSessionId: resolveLatestClaudeCodeSessionId,
    readLatestUxEffect,
  });
}

function formatClaudeCodeStatus(currentConfig: Record<string, unknown>): string {
  return [
    "TokenPilot Claude Code status:",
    `- enabled: ${formatOnOff(currentConfig.enabled)}`,
    `- stabilizer: ${formatOnOff(getNestedValue(currentConfig, ["modules", "stabilizer"]))}`,
    `- dynamicContextTarget: ${formatDisplayValue(getNestedValue(currentConfig, ["hooks", "dynamicContextTarget"]))}`,
    `- reduction: ${formatOnOff(getNestedValue(currentConfig, ["modules", "reduction"]))}`,
    `- triggerMinChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "triggerMinChars"]))}`,
    `- maxToolChars: ${formatDisplayValue(getNestedValue(currentConfig, ["reduction", "maxToolChars"]))}`,
    `- proxyPort: ${formatDisplayValue(currentConfig.proxyPort)}`,
    `- upstreamBaseUrl: ${formatDisplayValue(currentConfig.upstreamBaseUrl)}`,
  ].join("\n");
}

async function applyClaudeCodeMode(mode: "conservative" | "normal"): Promise<void> {
  const current = await loadConfig();
  await writeConfig(applyStandardRuntimeModeConfig(current, mode));
}

export function createClaudeCodeCliBridge(target: {
  host: "claude-code";
  sessionId?: string;
}): {
  bridge: TokenPilotProductSurfaceHostBridge;
  configAdapter: TokenPilotProductSurfaceConfigAdapter;
  maybeResolveLatestSessionId(): Promise<string | undefined>;
  handleCommand(ctx: { args: string; sessionId?: string }): Promise<{ text: string }>;
} {
  const bridge: TokenPilotProductSurfaceHostBridge = {
    loadConfig,
    writeConfig,
    async handleDoctor(currentConfig) {
      const config = currentConfig as any;
      const report = await inspectClaudeCodeDoctor({
        config,
        settingsPath: defaultClaudeCodeSettingsPath(),
        tokenPilotConfigPath: defaultTokenPilotClaudeCodeConfigPath(),
        mcpConfigPath: defaultClaudeCodeMcpConfigPath(),
      });
      return {
        text: formatClaudeCodeDoctorReport(report),
      };
    },
    async handleVisual(currentConfig) {
      const stateDir = resolveClaudeCodeStateDir(currentConfig);
      if (!stateDir) {
        return { text: "TokenPilot stateDir is not configured." };
      }
      const sessionId = await resolvePreferredSessionId({
        explicitSessionId: target.sessionId,
        stateDir,
        resolveLatestSessionId: resolveLatestClaudeCodeSessionId,
        readLatestUxEffect,
      });
      return handleStandaloneVisualCommandWithSelection({
        host: "claude-code",
        sessionId,
      });
    },
    async handleReport(_ctx, currentConfig) {
      return buildSessionReportResult({
        currentConfig,
        explicitSessionId: target.sessionId,
        configAdapter: claudeCodeProductSurfaceConfigAdapter,
        resolveLatestSessionId: resolveLatestClaudeCodeSessionId,
        readLatestUxEffect,
        readSessionAggregate: readUxSessionAggregate,
      });
    },
  };

  const handleCommand = createRestrictedHostCommandHandler({
    displayName: "Claude Code",
    cliHostName: "claude-code",
    reductionPassNames: CLAUDE_REDUCTION_PASS_NAMES,
    bridge,
    configAdapter: claudeCodeProductSurfaceConfigAdapter,
    loadConfig,
    formatStatus: formatClaudeCodeStatus,
    applyMode: applyClaudeCodeMode,
  });

  return {
    bridge,
    configAdapter: claudeCodeProductSurfaceConfigAdapter,
    maybeResolveLatestSessionId,
    handleCommand,
  };
}
