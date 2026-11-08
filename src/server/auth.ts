import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Role } from "../shop/staff.ts";

export interface StaffSession {
  tenantId: string;
  /** null for the owner login (password from .env). */
  staffId: number | null;
  username: string;
  name: string;
  role: Role;
  expiresAt: number;
}

export type SessionIdentity = Omit<StaffSession, "expiresAt">;

/**
 * Desk sessions, kept in memory (people log in again after a server restart).
 * Two ways in: the owner password from .env (always a manager), or a staff
 * account's username + PIN, checked by the shop's StaffService.
 */
export class StaffAuth {
  private readonly sessions = new Map<string, StaffSession>();
  private readonly ownerPasswordFor: (tenantId: string) => string | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { passwordFor: (tenantId: string) => string | undefined; ttlMs?: number; now?: () => number }) {
    this.ownerPasswordFor = options.passwordFor;
    this.ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** True when an owner password is configured for this tenant. */
  ownerEnabled(tenantId: string): boolean {
    return !!this.ownerPasswordFor(tenantId);
  }

  /** Constant-time check of the owner password. */
  checkOwner(tenantId: string, password: string): boolean {
    const expected = this.ownerPasswordFor(tenantId);
    if (!expected || typeof password !== "string") return false;
    const a = createHash("sha256").update(password).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
  }

  /** Starts a session and returns its token. */
  start(identity: SessionIdentity): string {
    this.pruneExpired();
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { ...identity, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  verify(token: string | undefined): StaffSession | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  /** Ends every session of one staff member (after deactivation or a PIN reset). */
  endSessionsFor(tenantId: string, staffId: number): void {
    for (const [token, s] of this.sessions) {
      if (s.tenantId === tenantId && s.staffId === staffId) this.sessions.delete(token);
    }
  }

  /** Ends every session for a business (used when the demo resets). */
  endAll(tenantId: string): void {
    for (const [token, s] of this.sessions) if (s.tenantId === tenantId) this.sessions.delete(token);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(token);
  }
}

/**
 * Reads the owner password from the environment:
 * STAFF_PASSWORD_BEAN_AND_BYTE for tenant "bean-and-byte", else STAFF_PASSWORD.
 * Passwords shorter than 8 characters are ignored.
 */
export function passwordFromEnv(env: NodeJS.ProcessEnv) {
  return (tenantId: string): string | undefined => {
    const specific = env[`STAFF_PASSWORD_${tenantId.toUpperCase().replace(/-/g, "_")}`];
    const password = specific || env.STAFF_PASSWORD;
    return password && password.length >= 8 ? password : undefined;
  };
}
