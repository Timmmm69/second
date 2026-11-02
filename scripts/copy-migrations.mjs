import { cp, mkdir } from "node:fs/promises";
await mkdir("dist-server/server/migrations", { recursive: true });
await cp("server/migrations", "dist-server/server/migrations", {
  recursive: true,
});
