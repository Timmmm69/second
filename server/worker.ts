import { tick } from "./jobs.js";
import { pool } from "./db.js";
let stopping = false,
  waitTimer: ReturnType<typeof setTimeout> | undefined,
  releaseWait: (() => void) | undefined;
function stop() {
  stopping = true;
  if (waitTimer) clearTimeout(waitTimer);
  releaseWait?.();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
while (!stopping) {
  try {
    await tick();
  } catch (e) {
    process.stderr.write(
      JSON.stringify({
        level: "error",
        event: "worker_failed",
        code: (e as any).code ?? "INTERNAL",
      }) + "\n",
    );
  }
  if (!stopping)
    await new Promise<void>((resolve) => {
      releaseWait = resolve;
      waitTimer = setTimeout(resolve, 30000);
    });
  releaseWait = undefined;
  waitTimer = undefined;
}
await pool.end();
