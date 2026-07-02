import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function reserveUnusedPort(): Promise<number> {
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

export async function withTempHome<T>(
  prefix: string,
  fn: (homeDir: string) => Promise<T>,
): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), prefix));
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    return await fn(homeDir);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true });
  }
}

export function createLongToolPayload(lines = 900): string {
  return `payload\n${"line\n".repeat(lines)}`;
}

export type MockJsonUpstream = {
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
};

export async function startMockJsonUpstream(params: {
  port?: number;
  path?: string;
  responseBody: Record<string, unknown>;
  responseHeaders?: Record<string, string>;
}): Promise<MockJsonUpstream> {
  const requests: Array<Record<string, unknown>> = [];
  const path = params.path ?? "/v1/responses";
  const port = params.port ?? await reserveUnusedPort();
  const server = createHttpServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== path) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    try {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    } catch {
      // ignore malformed body in test harness
    }

    const payload = JSON.stringify(params.responseBody);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    for (const [key, value] of Object.entries(params.responseHeaders ?? {})) {
      res.setHeader(key, value);
    }
    res.end(payload);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

export function extractRecoveryDataKey(text: string): string {
  const match = text.match(/memory_fault_recover with \{"dataKey":"([^"]+)"\}/);
  assert.ok(match, `expected recovery dataKey marker in:\n${text}`);
  return match[1];
}

export async function readArchiveSessionNames(stateDir: string): Promise<string[]> {
  const archiveRoot = join(stateDir, "tokenpilot", "tool-result-archives");
  const entries = await readdir(archiveRoot, { withFileTypes: true }).catch(() => []);
  return entries.map((entry) => entry.name);
}

export async function assertRecoveryRoundTrip(params: {
  reducedText: string;
  stateDir: string;
  recover(dataKey: string): Promise<{ isError: boolean; text: string }>;
  expectedPatterns?: RegExp[];
}): Promise<string> {
  const dataKey = extractRecoveryDataKey(params.reducedText);
  const sessionNames = await readArchiveSessionNames(params.stateDir);
  const result = await params.recover(dataKey);
  assert.equal(
    result.isError,
    false,
    `recovery failed for dataKey=${dataKey}; archiveSessions=${sessionNames.join(",")}; message=${result.text}`,
  );
  for (const pattern of params.expectedPatterns ?? [/Recovered content for:/, /payload/, /line/]) {
    assert.match(result.text, pattern);
  }
  return dataKey;
}

export async function assertProductSurfaceSmoke(params: {
  run(args: string): Promise<{ text: string }>;
  doctorPatterns: RegExp[];
  report: {
    sessionId?: string;
    unitLabel?: "chars" | "tokens";
    optimizedTurns?: number;
  };
  visual: {
    header: string;
    sessionId?: string;
    requiredPatterns?: RegExp[];
  };
}): Promise<void> {
  const doctor = await params.run("doctor");
  for (const pattern of params.doctorPatterns) {
    assert.match(doctor.text, pattern);
  }

  const report = await params.run("report");
  assertReportText({
    text: report.text,
    sessionId: params.report.sessionId,
    unitLabel: params.report.unitLabel,
    optimizedTurns: params.report.optimizedTurns,
  });

  const visual = await params.run("visual");
  assertVisualText({
    text: visual.text,
    header: params.visual.header,
    sessionId: params.visual.sessionId,
    requiredPatterns: params.visual.requiredPatterns,
  });
}

export function assertRecoveryProtocolText(text: string): void {
  assert.match(text, /\[Recovery Protocol\]/);
}

export function assertReductionMarkerText(text: string): void {
  assert.match(text, /\[Tool payload trimmed\]|\[Exec output truncated\]/);
}

export function assertStablePrefixRewrite(params: {
  sanitizedPromptText: string;
  dynamicContextText: string;
  workdir: string;
  agentId: string;
}): void {
  assert.match(params.sanitizedPromptText, /Your working directory is: <WORKDIR>/);
  assert.match(params.sanitizedPromptText, /Runtime: agent=<AGENT_ID>\s*\|/);
  assert.match(params.dynamicContextText, new RegExp(`WORKDIR: ${escapeRegExp(params.workdir)}`));
  assert.match(params.dynamicContextText, new RegExp(`AGENT_ID: ${escapeRegExp(params.agentId)}`));
}

export function assertReportText(params: {
  text: string;
  sessionId?: string;
  unitLabel?: "chars" | "tokens";
  optimizedTurns?: number;
}): void {
  assert.match(params.text, /TokenPilot report:/);
  if (params.sessionId) {
    assert.match(params.text, new RegExp(`session: ${escapeRegExp(params.sessionId)}`));
  }
  assert.match(params.text, new RegExp(`saved ${params.unitLabel ?? "chars"}:`));
  if (typeof params.optimizedTurns === "number") {
    assert.match(params.text, new RegExp(`optimized turns: ${params.optimizedTurns}`));
  }
}

export function assertVisualText(params: {
  text: string;
  header: string;
  sessionId?: string;
  requiredPatterns?: RegExp[];
}): void {
  assert.match(params.text, new RegExp(escapeRegExp(params.header)));
  if (params.sessionId) {
    assert.match(
      params.text,
      new RegExp(`session(?:: |=)${escapeRegExp(params.sessionId)}`),
    );
  }
  for (const pattern of params.requiredPatterns ?? []) {
    assert.match(params.text, pattern);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
