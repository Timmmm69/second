import { buildApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db.js";
const app = await buildApp();
await app.listen({ port: config.port, host: config.host });
console.log(
  JSON.stringify({
    event: "listening",
    port: config.port,
    mode: config.production ? "production" : "local",
  }),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
