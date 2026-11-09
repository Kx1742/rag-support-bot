import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SourceDocument, TenantConfig } from "./types.ts";

const SUPPORTED_EXTENSIONS = [".md", ".txt"];

/** Where business folders live. TENANTS_DIR overrides it (used by the end-to-end tests). */
export function tenantsDir(): string {
  return process.env.TENANTS_DIR ? resolve(process.env.TENANTS_DIR) : resolve(import.meta.dirname, "..", "tenants");
}
/**
 * Where indexes and shop databases live. Set DATA_DIR to put them on a persistent disk
 * (e.g. /var/data on Render). Read lazily so a value from .env is picked up.
 */
export function dataDir(): string {
  return process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(import.meta.dirname, "..", "data");
}

/** Tenant ids become folder names, so only allow safe characters. */
export function assertValidTenantId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
    throw new Error(`Invalid tenant id "${id}". Use lowercase letters, numbers and dashes.`);
  }
}

export function indexPath(tenantId: string, dir = dataDir()): string {
  assertValidTenantId(tenantId);
  return join(dir, tenantId, "index.json");
}

export async function loadTenant(
  tenantId: string,
  root = tenantsDir(),
): Promise<{ config: TenantConfig; docs: SourceDocument[] }> {
  assertValidTenantId(tenantId);
  const dir = join(root, tenantId);
  const config = JSON.parse(await readFile(join(dir, "tenant.json"), "utf8")) as TenantConfig;
  if (config.id !== tenantId) {
    throw new Error(`tenant.json id "${config.id}" does not match folder "${tenantId}"`);
  }

  const docsDir = join(dir, "docs");
  const files = (await readdir(docsDir))
    .filter((f) => SUPPORTED_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)))
    .sort();

  const docs = await Promise.all(
    files.map(async (file) => ({ docId: file, text: await readFile(join(docsDir, file), "utf8") })),
  );
  return { config, docs };
}
