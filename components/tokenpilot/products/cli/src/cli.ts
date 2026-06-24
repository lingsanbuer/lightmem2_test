import { dispatchCli } from "./dispatch.js";
import { maybeRunOpenClawVisualDaemon } from "./hosts/openclaw.js";

async function main() {
  if (await maybeRunOpenClawVisualDaemon(process.argv.slice(2))) {
    return;
  }
  const result = await dispatchCli(process.argv.slice(2));
  process.stdout.write(`${result.text}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
