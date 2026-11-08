// Usage: npm run backup -- [tenant-id]
// Writes a consistent copy of the shop database to data/<tenant>/backups (keeps the newest 7).
// Safe to run while the server is running.
import { join } from "node:path";
import { loadEnv } from "../app.ts";
import { openShop } from "../shop/shop.ts";
import { dataDir } from "../tenant.ts";

loadEnv();
const tenantId = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? process.env.DEFAULT_TENANT ?? "bean-and-byte";

try {
  const shop = await openShop(tenantId);
  if (!shop) throw new Error(`"${tenantId}" has no shop.json, so there is no shop database to back up.`);
  const file = shop.backup(join(dataDir(), tenantId, "backups"));
  shop.close();
  console.log(`Backup saved: ${file}`);
} catch (err) {
  console.error(`Backup failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
