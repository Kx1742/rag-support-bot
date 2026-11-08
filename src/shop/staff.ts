import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { ShopError } from "./errors.ts";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const ROLES = ["manager", "staff"] as const;
export type Role = (typeof ROLES)[number];

/** A staff account as the rest of the app sees it (never includes the PIN hash). */
export interface StaffMember {
  id: number;
  username: string;
  name: string;
  role: Role;
  active: boolean;
  createdAt: string;
}

interface Row {
  id: number;
  username: string;
  name: string;
  role: Role;
  pin_hash: string;
  active: number;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
}

const MAX_FAILED = 5;
const LOCK_MINUTES = 5;
/** "owner" logs in with the password from .env, so no account may take that name. */
export const OWNER_USERNAME = "owner";

/**
 * Per-staff accounts with their own PIN. PINs are hashed with scrypt and a random salt;
 * an account locks for a few minutes after repeated wrong PINs.
 */
export class StaffService {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(deps: { db: DatabaseSync; now: () => Date }) {
    this.db = deps.db;
    this.now = deps.now;
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM staff WHERE active = 1`).get() as { n: number }).n;
  }

  list(): StaffMember[] {
    const rows = this.db.prepare(`SELECT * FROM staff ORDER BY active DESC, role, name`).all() as unknown as Row[];
    return rows.map(toMember);
  }

  get(id: number): StaffMember | null {
    const row = this.db.prepare(`SELECT * FROM staff WHERE id = ?`).get(id) as unknown as Row | undefined;
    return row ? toMember(row) : null;
  }

  async create(input: { username: string; name: string; role: Role; pin: string }): Promise<StaffMember> {
    const username = normalizeUsername(input.username);
    const name = String(input.name ?? "").trim().replace(/\s+/g, " ");
    if (!name || name.length > 60) throw new ShopError("invalid_name", "Name must be 1-60 characters.");
    assertRole(input.role);
    assertPin(input.pin);
    if (this.db.prepare(`SELECT 1 FROM staff WHERE username = ?`).get(username)) {
      throw new ShopError("taken", `The username "${username}" is already used.`);
    }
    const stamp = this.now().toISOString();
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO staff (username, name, role, pin_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(username, name, input.role, await hashPin(input.pin), stamp, stamp);
    return this.get(Number(lastInsertRowid))!;
  }

  /** Change name, role, active flag or PIN. Keeps at least one active manager account. */
  async update(id: number, changes: { name?: string; role?: Role; active?: boolean; pin?: string }): Promise<StaffMember> {
    const current = this.get(id);
    if (!current) throw new ShopError("not_found", "Staff member not found");

    const name = changes.name === undefined ? current.name : String(changes.name).trim().replace(/\s+/g, " ");
    if (!name || name.length > 60) throw new ShopError("invalid_name", "Name must be 1-60 characters.");
    const role = changes.role ?? current.role;
    assertRole(role);
    const active = changes.active ?? current.active;

    const losesManager = current.role === "manager" && current.active && (role !== "manager" || !active);
    if (losesManager && this.activeManagers() <= 1) {
      throw new ShopError("last_manager", "Keep at least one active manager account.");
    }

    const stamp = this.now().toISOString();
    this.db.prepare(`UPDATE staff SET name = ?, role = ?, active = ?, updated_at = ? WHERE id = ?`).run(name, role, active ? 1 : 0, stamp, id);
    if (changes.pin !== undefined) {
      assertPin(changes.pin);
      this.db
        .prepare(`UPDATE staff SET pin_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`)
        .run(await hashPin(changes.pin), stamp, id);
    }
    return this.get(id)!;
  }

  /**
   * Checks a username + PIN. Returns the member, or null for any failure
   * (unknown user, wrong PIN, inactive, locked) so attackers learn nothing.
   */
  async authenticate(usernameRaw: string, pin: string): Promise<StaffMember | null> {
    const username = String(usernameRaw ?? "").trim().toLowerCase();
    const row = this.db.prepare(`SELECT * FROM staff WHERE username = ?`).get(username) as unknown as Row | undefined;
    if (!row) {
      await hashPin("0000"); // same work as a real check, so timing doesn't reveal valid usernames
      return null;
    }
    const now = this.now();
    if (row.locked_until && new Date(row.locked_until) > now) return null;

    const ok = await verifyPin(String(pin ?? ""), row.pin_hash);
    if (!ok || !row.active) {
      const failed = row.failed_attempts + 1;
      const lock = failed >= MAX_FAILED ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() : null;
      this.db.prepare(`UPDATE staff SET failed_attempts = ?, locked_until = ? WHERE id = ?`).run(lock ? 0 : failed, lock, row.id);
      return null;
    }
    this.db.prepare(`UPDATE staff SET failed_attempts = 0, locked_until = NULL WHERE id = ?`).run(row.id);
    return toMember(row);
  }

  private activeManagers(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM staff WHERE role = 'manager' AND active = 1`).get() as { n: number }).n;
  }
}

function toMember(r: Row): StaffMember {
  return { id: r.id, username: r.username, name: r.name, role: r.role, active: r.active === 1, createdAt: r.created_at };
}

function normalizeUsername(raw: string): string {
  const username = String(raw ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,29}$/.test(username)) {
    throw new ShopError("invalid_username", "Username must be 2-30 characters: letters, numbers, dot, dash or underscore.");
  }
  if (username === OWNER_USERNAME) throw new ShopError("invalid_username", `"${OWNER_USERNAME}" is reserved.`);
  return username;
}

function assertRole(role: unknown): asserts role is Role {
  if (!ROLES.includes(role as Role)) throw new ShopError("invalid_role", "Role must be manager or staff.");
}

/** 4-8 digits, and not something trivially guessable. */
export function assertPin(pin: unknown): void {
  const p = String(pin ?? "");
  if (!/^\d{4,8}$/.test(p)) throw new ShopError("invalid_pin", "PIN must be 4-8 digits.");
  const sequential = "0123456789012345678".includes(p) || "9876543210987654321".includes(p);
  if (/^(\d)\1+$/.test(p) || sequential) throw new ShopError("weak_pin", "That PIN is too easy to guess. Avoid repeated or sequential digits.");
}

async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pin, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scryptAsync(pin, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}
