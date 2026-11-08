import type { DatabaseSync } from "node:sqlite";
import { normalizePhone } from "./bookings.ts";
import type { LoyaltyConfig, LoyaltyReward } from "./config.ts";
import { ShopError } from "./errors.ts";

export interface Member {
  id: number;
  phone: string;
  name: string;
  points: number;
  /** All points ever earned (for "member since" style stats). */
  lifetime: number;
  lastActivity: string;
  createdAt: string;
}

export interface LedgerEntry {
  delta: number;
  reason: string;
  orderId: number | null;
  by: string;
  at: string;
}

/** What a member can do with their points right now. */
export interface MemberSummary {
  points: number;
  rewards: { id: string; name: string; points: number; affordable: boolean }[];
  nextReward: { name: string; pointsNeeded: number } | null;
}

/** A line as the reward maths needs it. */
export interface RewardLine {
  itemId: string;
  name: string;
  category: string;
  unitPrice: number;
  quantity: number;
}

interface Row {
  id: number;
  phone: string;
  name: string;
  points: number;
  lifetime: number;
  last_activity: string;
  created_at: string;
}

/**
 * Loyalty program: members are identified by phone number, earn points on what they pay,
 * and spend points on rewards. Every balance change is written to a ledger.
 */
export class LoyaltyService {
  private readonly db: DatabaseSync;
  readonly config: LoyaltyConfig | null;
  private readonly now: () => Date;

  constructor(deps: { db: DatabaseSync; config: LoyaltyConfig | undefined; now: () => Date }) {
    this.db = deps.db;
    this.config = deps.config ?? null;
    this.now = deps.now;
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  find(phoneRaw: string): Member | null {
    const phone = normalizePhone(phoneRaw ?? "");
    if (!phone) return null;
    const row = this.db.prepare(`SELECT * FROM loyalty_members WHERE phone = ?`).get(phone) as unknown as Row | undefined;
    return row ? this.withExpiry(row) : null;
  }

  get(id: number): Member | null {
    const row = this.db.prepare(`SELECT * FROM loyalty_members WHERE id = ?`).get(id) as unknown as Row | undefined;
    return row ? this.withExpiry(row) : null;
  }

  join(phoneRaw: string, nameRaw = ""): Member {
    this.requireEnabled();
    const phone = normalizePhone(phoneRaw ?? "");
    if (!phone) throw new ShopError("invalid_phone", "Enter a valid phone number (7-15 digits).");
    const name = String(nameRaw ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (this.find(phone)) throw new ShopError("taken", "That phone number is already a member.");
    const stamp = this.now().toISOString();
    const { lastInsertRowid } = this.db
      .prepare(`INSERT INTO loyalty_members (phone, name, last_activity, created_at) VALUES (?, ?, ?, ?)`)
      .run(phone, name, stamp, stamp);
    return this.get(Number(lastInsertRowid))!;
  }

  summary(member: Member): MemberSummary {
    const rewards = (this.config?.rewards ?? []).map((r) => ({ id: r.id, name: r.name, points: r.points, affordable: member.points >= r.points }));
    const next = rewards.filter((r) => !r.affordable).sort((a, b) => a.points - b.points)[0];
    return {
      points: member.points,
      rewards,
      nextReward: next ? { name: next.name, pointsNeeded: next.points - member.points } : null,
    };
  }

  history(memberId: number, limit = 20): LedgerEntry[] {
    const rows = this.db
      .prepare(`SELECT delta, reason, order_id, by_name, created_at FROM loyalty_ledger WHERE member_id = ? ORDER BY id DESC LIMIT ?`)
      .all(memberId, limit) as { delta: number; reason: string; order_id: number | null; by_name: string; created_at: string }[];
    return rows.map((r) => ({ delta: r.delta, reason: r.reason, orderId: r.order_id, by: r.by_name, at: r.created_at }));
  }

  reward(id: string): LoyaltyReward {
    const reward = this.config?.rewards.find((r) => r.id === id);
    if (!reward) throw new ShopError("invalid_reward", "Unknown reward.");
    return reward;
  }

  /** Points earned for paying this many cents (whole dollars only). */
  pointsFor(amountCents: number): number {
    return this.config ? Math.floor(amountCents / 100) * this.config.pointsPerDollar : 0;
  }

  /**
   * Changes a balance and writes the ledger. Call inside the order's transaction.
   * Spending more than the balance throws; taking back earned points stops at 0.
   */
  change(memberId: number, delta: number, reason: string, opts: { orderId?: number; by?: string; clampAtZero?: boolean } = {}): number {
    const member = this.get(memberId);
    if (!member) throw new ShopError("not_found", "Loyalty member not found");
    let applied = delta;
    if (member.points + delta < 0) {
      if (!opts.clampAtZero) throw new ShopError("not_enough_points", `Not enough points: ${member.points} available.`);
      applied = -member.points;
    }
    if (applied === 0) return 0;
    const stamp = this.now().toISOString();
    this.db
      .prepare(`UPDATE loyalty_members SET points = points + ?, lifetime = lifetime + ?, last_activity = ? WHERE id = ?`)
      .run(applied, reason.startsWith("Earned") ? Math.max(applied, 0) : 0, stamp, memberId);
    this.db
      .prepare(`INSERT INTO loyalty_ledger (member_id, order_id, delta, reason, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(memberId, opts.orderId ?? null, applied, reason, opts.by ?? "", stamp);
    return applied;
  }

  private requireEnabled(): void {
    if (!this.config) throw new ShopError("loyalty_off", "This business doesn't have a loyalty program.");
  }

  /** Points expire after a period with no activity at all. */
  private withExpiry(row: Row): Member {
    const months = this.config?.expiryMonths;
    if (months && row.points > 0) {
      const cutoff = new Date(this.now());
      cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
      if (new Date(row.last_activity) < cutoff) {
        const stamp = this.now().toISOString();
        this.db.prepare(`UPDATE loyalty_members SET points = 0 WHERE id = ?`).run(row.id);
        this.db
          .prepare(`INSERT INTO loyalty_ledger (member_id, delta, reason, created_at) VALUES (?, ?, ?, ?)`)
          .run(row.id, -row.points, `Expired after ${months} months without activity`, stamp);
        row = { ...row, points: 0 };
      }
    }
    return {
      id: row.id,
      phone: row.phone,
      name: row.name,
      points: row.points,
      lifetime: row.lifetime,
      lastActivity: row.last_activity,
      createdAt: row.created_at,
    };
  }
}

/**
 * Works out a reward's discount: each part makes one matching unit free, choosing the
 * most expensive match (so "free drink, any size" covers a large oat latte).
 */
export function rewardDiscount(reward: LoyaltyReward, lines: RewardLine[]): { discount: number; freeItems: string[] } {
  const units = lines.flatMap((l) => Array.from({ length: l.quantity }, () => ({ ...l, used: false })));
  let discount = 0;
  const freeItems: string[] = [];
  for (const part of reward.parts) {
    const match = units
      .filter((u) => !u.used && (part.items?.includes(u.itemId) || part.categories?.includes(u.category)))
      .sort((a, b) => b.unitPrice - a.unitPrice)[0];
    if (!match) throw new ShopError("reward_not_applicable", `Add a ${part.label} to the order to use "${reward.name}".`);
    match.used = true;
    discount += match.unitPrice;
    freeItems.push(match.name);
  }
  return { discount, freeItems };
}
