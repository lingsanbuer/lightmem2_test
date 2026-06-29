import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type {
  TokenPilotProductSurfaceConfigAdapter,
  TokenPilotProductSurfaceHostBridge,
} from "@tokenpilot/host-adapter";
import { readLatestUxEffect, readSessionUxAggregate } from "../../../../adapters/openclaw/src/context-stack/integration/ux-effects.js";
import { resolveOpenClawConfigPath } from "../../../../adapters/openclaw/src/context-stack/integration/openclaw-paths.js";
import { openClawProductSurfaceConfigAdapter, resolveStateDir } from "../../../../adapters/openclaw/src/commands/tokenpilot/host-config-adapter.js";
import { formatOpenClawDoctorReport, inspectOpenClawDoctor } from "../../../../adapters/openclaw/src/commands/tokenpilot/openclaw-doctor.js";
import { buildSessionReportResult, resolveConfiguredPreferredSessionId } from "./shared.js";

function normalizeSessionId(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function visualPidPath(stateDir: string): string {
  return join(stateDir, "visual-server.pid");
}

function visualMetaPath(stateDir: string): string {
  return join(stateDir, "visual-server.json");
}

function visualLogPath(stateDir: string): string {
  return join(stateDir, "visual-server.log");
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForVisualServer(url: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${url}/health`);
      if (resp.ok) return true;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

async function loadConfig(): Promise<Record<string, unknown>> {
  const configPath = resolveOpenClawConfigPath();
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeConfig(nextConfig: Record<string, unknown>): Promise<void> {
  const configPath = resolveOpenClawConfigPath();
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
}

async function maybeResolveLatestSessionId(): Promise<string | undefined> {
  return resolveConfiguredPreferredSessionId({
    loadConfig,
    resolveStateDir,
    async resolveLatestSessionId() {
      return undefined;
    },
    readLatestUxEffect,
  });
}

async function ensureVisualServerForStateDir(stateDir: string): Promise<string> {
  const metaFile = visualMetaPath(stateDir);
  const pidFile = visualPidPath(stateDir);
  const currentMeta = existsSync(metaFile)
    ? JSON.parse(await readFile(metaFile, "utf8")) as { url?: string; pid?: number }
    : {};
  const currentPid = Number(currentMeta.pid ?? 0);
  if (currentMeta.url && currentPid > 0 && isProcessRunning(currentPid)) {
    const healthy = await waitForVisualServer(currentMeta.url, 500);
    if (healthy) return currentMeta.url;
  }

  await mkdir(stateDir, { recursive: true });
  const log = await open(visualLogPath(stateDir), "a");
  const child = spawn(process.execPath, [__filename, "__openclaw_visual_daemon", stateDir], {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: process.env,
  });
  child.unref();
  await log.close().catch(() => undefined);
  await writeFile(pidFile, `${child.pid}\n`, "utf8");

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if (existsSync(metaFile)) {
        const parsed = JSON.parse(await readFile(metaFile, "utf8")) as { url?: string; pid?: number };
        if (parsed.url && Number(parsed.pid) === child.pid) {
          const healthy = await waitForVisualServer(parsed.url, 1000);
          if (healthy) return parsed.url;
        }
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  if (isProcessRunning(child.pid ?? 0)) {
    try {
      process.kill(child.pid ?? 0, "SIGTERM");
    } catch {
      // ignore
    }
  }
  await rm(pidFile, { force: true }).catch(() => undefined);
  throw new Error(`Failed to start LightMem2 visual server for ${stateDir}`);
}

export async function maybeRunOpenClawVisualDaemon(argv: string[]): Promise<boolean> {
  if (argv[0] !== "__openclaw_visual_daemon") return false;
  const stateDir = String(argv[1] ?? "").trim();
  if (!stateDir) {
    throw new Error("Missing stateDir for visual daemon");
  }
  const { startVisualServer } = await import("@tokenpilot/product-surface");
  const handle = await startVisualServer(stateDir, { unref: false });
  await writeFile(
    visualMetaPath(stateDir),
    `${JSON.stringify({ url: handle.url, pid: process.pid, stateDir }, null, 2)}\n`,
    "utf8",
  );
  return new Promise<boolean>(() => undefined);
}

export function createOpenClawCliBridge(target: {
  host: "openclaw";
  sessionId?: string;
}): {
  bridge: TokenPilotProductSurfaceHostBridge;
  configAdapter: TokenPilotProductSurfaceConfigAdapter;
  maybeResolveLatestSessionId(): Promise<string | undefined>;
} {
  const bridge: TokenPilotProductSurfaceHostBridge = {
    loadConfig,
    writeConfig,
    async handleDoctor(currentConfig) {
      return {
        text: formatOpenClawDoctorReport(inspectOpenClawDoctor(currentConfig)),
      };
    },
    async handleVisual(currentConfig) {
      const stateDir = resolveStateDir(currentConfig);
      const effectiveStateDir = stateDir ?? "";
      if (!effectiveStateDir) {
        return { text: "TokenPilot stateDir is not configured." };
      }
      const url = await ensureVisualServerForStateDir(effectiveStateDir);
      const sessions = await (await import("@tokenpilot/product-surface")).readVisualSessionList(effectiveStateDir);
      const lines = [
        `TokenPilot visual: ${url}`,
        `- sessions with snapshots: ${sessions.length}`,
        "- open this URL in your browser to inspect reduction and eviction before/after views",
      ];
      if (sessions.length === 0) {
        lines.push("- no visual snapshots yet; new reduction/eviction events will appear after future turns");
      }
      return { text: lines.join("\n") };
    },
    async handleReport(_ctx, currentConfig) {
      return buildSessionReportResult({
        currentConfig,
        explicitSessionId: target.sessionId,
        configAdapter: openClawProductSurfaceConfigAdapter,
        async resolveLatestSessionId() {
          return undefined;
        },
        readLatestUxEffect,
        readSessionAggregate: readSessionUxAggregate,
      });
    },
  };

  return {
    bridge,
    configAdapter: openClawProductSurfaceConfigAdapter,
    maybeResolveLatestSessionId,
  };
}
