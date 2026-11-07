import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface StaffSession {
  tenantId: string;
  expiresAt: number;
}

/**
 * Staff login for the shop desk: one shared password per business, sessions kept
 * in memory (staff log in again after a server restart).
 * Upgrade path: per-staff accounts with hashed passwords in the database.
 */
export class StaffAuth {
  private readonly sessions = new Map<string, StaffSession>();
  private readonly passwordFor: (tenantId: string) => string | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { passwordFor: (tenantId: string) => string | undefined; ttlMs?: number; now?: () => number }) {
    this.passwordFor = options.passwordFor;
    this.ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** True when a password is configured, i.e. the desk is switched on for this tenant. */
  isEnabled(tenantId: string): boolean {
    return !!this.passwordFor(tenantId);
  }

  /** Returns a session token, or null if the password is wrong. */
  login(tenantId: string, password: string): string | null {
    const expected = this.passwordFor(tenantId);
    if (!expected || typeof password !== "string") return null;
    // Hash both so the comparison is constant-time even for different lengths.
    const a = createHash("sha256").update(password).digest();
    const b = createHash("sha256").update(expected).digest();
    if (!timingSafeEqual(a, b)) return null;

    this.pruneExpired();
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { tenantId, expiresAt: this.now() + this.ttlMs });
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

  private pruneExpired(): void {
    const now = this.now();
    for (const [token, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(token);
  }
}

/**
 * Reads the desk password from the environment:
 * STAFF_PASSWORD_BEAN_AND_BYTE for tenant "bean-and-byte", else STAFF_PASSWORD.
 * Passwords shorter than 8 characters are ignored (desk stays off).
 */
export function passwordFromEnv(env: NodeJS.ProcessEnv) {
  return (tenantId: string): string | undefined => {
    const specific = env[`STAFF_PASSWORD_${tenantId.toUpperCase().replace(/-/g, "_")}`];
    const password = specific || env.STAFF_PASSWORD;
    return password && password.length >= 8 ? password : undefined;
  };
}
