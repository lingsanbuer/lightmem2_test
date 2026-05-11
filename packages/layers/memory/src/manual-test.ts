import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalProceduralMemoryBackend } from "./local-backend.js";
import { formatProceduralMemoryInjection } from "./injection.js";
import { createPromptingDistiller } from "./prompting-distiller.js";
import { runProceduralMemoryBatch } from "./worker.js";
import type { ProceduralSkill, SkillDistiller } from "./types.js";

function createStubDistiller(): SkillDistiller {
  return {
    async distill(params) {
      return params.entries.map((entry): ProceduralSkill => ({
        skillId: `stub-${entry.taskId}`,
        sourceTaskId: entry.taskId,
        sessionId: entry.sessionId,
        title: `Stub skill for ${entry.taskId}`,
        objective: entry.objective,
        guidance: `Follow the archived procedure for ${entry.objective}.`,
        whenToUse: [entry.objective],
        steps: [
          "Inspect the archived task objective first",
          "Reuse the validated procedure",
          "Avoid previously observed pitfalls",
        ],
        facts: ["Preserve transcript-grounded specifics that materially affected correctness."],
        pitfalls: entry.unresolvedQuestions.length > 0 ? entry.unresolvedQuestions : ["Do not skip validation"],
        constraints: ["session-bound memory only"],
        evidence: [...entry.completionEvidence],
        embeddingText: [entry.objective, ...entry.completionEvidence, ...entry.unresolvedQuestions].join("\n"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
    },
  };
}

async function loadKuaipaoProviderConfig(): Promise<{ baseUrl: string; apiKey: string; model: string }> {
  const configPath = join(process.env.HOME || "", ".openclaw", "openclaw.json");
  const raw = JSON.parse(await readFile(configPath, "utf8")) as any;
  const provider = raw?.models?.providers?.kuaipao;
  const baseUrl = String(provider?.baseUrl ?? "").trim();
  const apiKey = String(provider?.apiKey ?? "").trim();
  const model = String(provider?.models?.[0]?.id ?? "gpt-5.4-mini").trim();
  if (!baseUrl || !apiKey || !model) {
    throw new Error("kuaipao_provider_not_configured");
  }
  return { baseUrl, apiKey, model };
}

async function main() {
  const usePrompting = process.argv.includes("--prompting");
  const root = join(tmpdir(), `tokenpilot-memory-test-${Date.now()}`);
  const stateDir = join(root, "state");
  const archiveDir = join(root, "archives");
  await mkdir(stateDir, { recursive: true });
  await mkdir(archiveDir, { recursive: true });

  const archivePath = join(archiveDir, "task-001.txt");
  await writeFile(
    archivePath,
    [
      "[user] Audit scheduled tasks and identify failing jobs.",
      "[assistant] First list all jobs, then inspect failures, apply safe remediation, and escalate unresolved issues.",
    ].join("\n"),
    "utf8",
  );

  const backend = createLocalProceduralMemoryBackend(stateDir);
  const enqueued = await backend.enqueue([
    {
      sessionId: "session-a",
      taskId: "task-001",
      archivePath,
      archiveSourceLabel: "manual_test",
      objective: "Audit scheduled tasks and remediate failing jobs",
      completionEvidence: ["Listed jobs", "Inspected failures", "Applied safe remediation"],
      unresolvedQuestions: ["Escalate jobs requiring manual approval"],
      turnAbsIds: ["turn-1", "turn-2"],
    },
  ]);

  const kuaipao = usePrompting ? await loadKuaipaoProviderConfig() : null;
  const batch = await runProceduralMemoryBatch({
    backend,
    batchSize: 2,
    distiller: usePrompting
      ? createPromptingDistiller({
        baseUrl: kuaipao!.baseUrl,
        apiKey: kuaipao!.apiKey,
        model: kuaipao!.model,
        requestTimeoutMs: 60_000,
      })
      : createStubDistiller(),
  });

  const hits = await backend.retrieve({
    sessionId: "session-a",
    objective: "Audit scheduled jobs and fix failing tasks",
    topK: 1,
  });
  const injected = formatProceduralMemoryInjection(hits);

  console.log(
    JSON.stringify(
      {
        root,
        mode: usePrompting ? "prompting" : "stub",
        enqueued,
        batch,
        hitCount: hits.length,
        topSkillTitle: hits[0]?.skill.title ?? null,
        injected,
      },
      null,
      2,
    ),
  );
}

void main();
