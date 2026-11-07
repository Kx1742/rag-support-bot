import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ShopConfig, TableConfig } from "./config.ts";
import { transaction } from "./db.ts";
import { ShopError } from "./errors.ts";
import { addDays, describeDate, fromMinutes, isDate, isTime, toMinutes, weekdayOf, zonedNow } from "./time.ts";

export const BOOKING_STATUSES = ["confirmed", "seated", "completed", "cancelled", "no_show"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export type BookingSource = "chat" | "web" | "staff";

/** Which status changes staff may make. */
const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  confirmed: ["seated", "cancelled", "no_show"],
  seated: ["completed", "confirmed"],
  completed: ["seated"],
  cancelled: [],
  no_show: ["confirmed"],
};
const ACTIVE: BookingStatus[] = ["confirmed", "seated"];

export interface Booking {
  id: number;
  reference: string;
  date: string;
  time: string;
  endTime: string;
  partySize: number;
  tableId: string;
  tableName: string;
  name: string;
  phone: string;
  notes: string;
  status: BookingStatus;
  source: BookingSource;
  createdAt: string;
}

export interface BookingInput {
  date: string;
  time: string;
  partySize: number;
  name: string;
  phone?: string;
  notes?: string;
  /** Staff only: pick a specific table. */
  tableId?: string;
}

/** What a customer may see about a booking (no phone or internal fields). */
export interface PublicBooking {
  reference: string;
  date: string;
  dateText: string;
  time: string;
  partySize: number;
  name: string;
  status: BookingStatus;
}

interface Row {
  id: number;
  reference: string;
  date: string;
  start_min: number;
  end_min: number;
  party_size: number;
  table_id: string;
  name: string;
  phone: string;
  notes: string;
  status: BookingStatus;
  source: BookingSource;
  created_at: string;
}

export class BookingService {
  private readonly db: DatabaseSync;
  private readonly config: ShopConfig;
  private readonly now: () => Date;
  private readonly onChange: (id: number, action: "created" | "updated") => void;

  constructor(deps: {
    db: DatabaseSync;
    config: ShopConfig;
    now: () => Date;
    onChange?: (id: number, action: "created" | "updated") => void;
  }) {
    this.db = deps.db;
    this.config = deps.config;
    this.now = deps.now;
    this.onChange = deps.onChange ?? (() => {});
  }

  get maxPartySize(): number {
    return Math.max(0, ...this.config.tables.map((t) => t.seats));
  }

  /** Bookable start times for a date and party size. */
  availableTimes(date: string, partySize: number, opts: { staff?: boolean; tableId?: string } = {}): { times: string[]; reason?: string } {
    this.assertParty(partySize);
    const closed = this.dayProblem(date, opts.staff);
    if (closed) return { times: [], reason: closed };

    const busy = this.busyByTable(date);
    const times = this.slotStarts(date, opts.staff).filter(
      (start) => this.freeTable(busy, start, start + this.config.booking.durationMinutes, partySize, opts.tableId) !== null,
    );
    return times.length
      ? { times: times.map(fromMinutes) }
      : {
          times: [],
          reason: opts.tableId
            ? `That table has no free slot for ${partySize} on ${describeDate(date)}.`
            : `Sorry, we're fully booked for ${partySize} on ${describeDate(date)}.`,
        };
  }

  /** Checks one specific time, suggesting the closest alternatives when it's taken. */
  check(date: string, time: string, partySize: number): { available: boolean; reason?: string; alternatives: string[] } {
    if (!isTime(time)) throw new ShopError("invalid_time", "Time must be HH:MM, e.g. 10:30");
    const { times, reason } = this.availableTimes(date, partySize);
    if (times.includes(time)) return { available: true, alternatives: [] };

    const target = toMinutes(time);
    const alternatives = [...times].sort((a, b) => Math.abs(toMinutes(a) - target) - Math.abs(toMinutes(b) - target)).slice(0, 3).sort();
    const today = this.today();
    let why = reason;
    if (!why && date === today.date && target < today.minutes + this.config.booking.minNoticeMinutes) {
      why = `Bookings need at least ${this.config.booking.minNoticeMinutes} minutes' notice.`;
    }
    if (!why) why = this.slotStarts(date).includes(target) ? "That time is already fully booked." : this.hoursText(date);
    return { available: false, reason: why, alternatives };
  }

  create(input: BookingInput, source: BookingSource): Booking {
    const staff = source === "staff";
    const name = String(input.name ?? "").trim().replace(/\s+/g, " ");
    const notes = String(input.notes ?? "").trim();
    const phone = normalizePhone(input.phone ?? "");

    if (!name || name.length > 80) throw new ShopError("invalid_name", "Please give a name (up to 80 characters).");
    if (notes.length > 300) throw new ShopError("invalid_notes", "Notes can be up to 300 characters.");
    if (!staff && !phone) throw new ShopError("invalid_phone", "Please give a valid phone number (7-15 digits).");
    if (input.phone && !phone) throw new ShopError("invalid_phone", "Please give a valid phone number (7-15 digits).");
    if (!isTime(input.time)) throw new ShopError("invalid_time", "Time must be HH:MM, e.g. 10:30");
    this.assertParty(input.partySize);

    return transaction(this.db, () => {
      const problem = this.dayProblem(input.date, staff);
      if (problem) throw new ShopError("unavailable", problem);

      const start = toMinutes(input.time);
      if (!this.slotStarts(input.date, staff).includes(start)) {
        throw new ShopError("unavailable", staff ? this.hoursText(input.date) : `That time can't be booked. ${this.hoursText(input.date)}`);
      }

      if (!staff && phone && this.config.booking.maxActivePerPhone > 0) {
        const { n } = this.db
          .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE phone = ? AND date >= ? AND status = 'confirmed'`)
          .get(phone, this.today().date) as { n: number };
        if (n >= this.config.booking.maxActivePerPhone) {
          throw new ShopError("too_many", "This phone number already has the maximum number of upcoming bookings.");
        }
      }

      const end = start + this.config.booking.durationMinutes;
      const table = this.freeTable(this.busyByTable(input.date), start, end, input.partySize, input.tableId);
      if (!table) {
        throw new ShopError("unavailable", input.tableId ? "That table is not free at that time." : "Sorry, that time was just booked.");
      }

      const stamp = this.now().toISOString();
      const reference = this.newReference();
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO bookings (reference, date, start_min, end_min, party_size, table_id, name, phone, notes, status, source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
        )
        .run(reference, input.date, start, end, input.partySize, table.id, name, phone, notes, source, stamp, stamp);
      const id = Number(lastInsertRowid);
      this.onChange(id, "created");
      return this.get(id)!;
    });
  }

  list(date: string): Booking[] {
    if (!isDate(date)) throw new ShopError("invalid_date", "Date must be YYYY-MM-DD");
    const rows = this.db.prepare(`SELECT * FROM bookings WHERE date = ? ORDER BY start_min, id`).all(date) as unknown as Row[];
    return rows.map((r) => this.toBooking(r));
  }

  get(id: number): Booking | null {
    const row = this.db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(id) as unknown as Row | undefined;
    return row ? this.toBooking(row) : null;
  }

  setStatus(id: number, status: BookingStatus): Booking {
    const booking = this.get(id);
    if (!booking) throw new ShopError("not_found", "Booking not found");
    if (!BOOKING_STATUSES.includes(status)) throw new ShopError("invalid_status", `Unknown status "${status}"`);
    if (booking.status === status) return booking;
    if (!TRANSITIONS[booking.status].includes(status)) {
      throw new ShopError("invalid_status", `Can't change a ${booking.status} booking to ${status}.`);
    }
    if (status === "confirmed" && booking.status === "no_show") {
      // Restoring a no-show: make sure nobody took the table meanwhile.
      const busy = this.busyByTable(booking.date);
      const start = toMinutes(booking.time);
      if (!this.freeTable(busy, start, toMinutes(booking.endTime), booking.partySize, booking.tableId)) {
        throw new ShopError("unavailable", "That table has been booked by someone else since.");
      }
    }
    this.db.prepare(`UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?`).run(status, this.now().toISOString(), id);
    this.onChange(id, "updated");
    return this.get(id)!;
  }

  /** Customer self-cancel: needs both the reference and the phone used to book. */
  cancelByReference(reference: string, phone: string): Booking {
    const ref = String(reference ?? "").trim().toUpperCase();
    const row = this.db.prepare(`SELECT * FROM bookings WHERE reference = ?`).get(ref) as unknown as Row | undefined;
    // Same message for "no such booking" and "wrong phone", so references can't be probed.
    if (!row || !phone || row.phone !== normalizePhone(phone)) {
      throw new ShopError("not_found", "No booking matches that reference and phone number.");
    }
    if (row.status !== "confirmed") throw new ShopError("invalid_status", `This booking is already ${row.status.replace("_", "-")}.`);
    if (row.date < this.today().date) throw new ShopError("invalid_status", "This booking is in the past.");
    return this.setStatus(row.id, "cancelled");
  }

  toPublic(b: Booking): PublicBooking {
    return {
      reference: b.reference,
      date: b.date,
      dateText: describeDate(b.date),
      time: b.time,
      partySize: b.partySize,
      name: b.name,
      status: b.status,
    };
  }

  today(): { date: string; minutes: number } {
    return zonedNow(this.config.timezone, this.now());
  }

  hoursText(date: string): string {
    const hours = isDate(date) ? this.config.openingHours[weekdayOf(date)] : undefined;
    if (!hours) return "We're closed that day.";
    const lastStart = toMinutes(hours[1]) - this.config.booking.durationMinutes;
    return `On ${describeDate(date)} we take bookings from ${hours[0]} to ${fromMinutes(lastStart)}.`;
  }

  // ---------- internals ----------

  private assertParty(partySize: number): void {
    if (!Number.isInteger(partySize) || partySize < 1) throw new ShopError("invalid_party", "Party size must be at least 1.");
    if (partySize > this.maxPartySize) {
      throw new ShopError("party_too_large", `We can seat up to ${this.maxPartySize} people per booking. For bigger groups, ask about catering.`);
    }
  }

  /** Why a date can't be booked, or null if it can. */
  private dayProblem(date: string, staff = false): string | null {
    if (!isDate(date)) throw new ShopError("invalid_date", "Date must be YYYY-MM-DD");
    const today = this.today().date;
    if (date < today) return "That date is in the past.";
    if (!staff && date > addDays(today, this.config.booking.maxDaysAhead)) {
      return `We take bookings up to ${this.config.booking.maxDaysAhead} days ahead.`;
    }
    if (this.config.closedDates.includes(date) || !this.config.openingHours[weekdayOf(date)]) {
      return `We're closed on ${describeDate(date)}.`;
    }
    return null;
  }

  /** Start minutes on the slot grid that end by closing time and respect the notice period. */
  private slotStarts(date: string, staff = false): number[] {
    const hours = this.config.openingHours[weekdayOf(date)];
    if (!hours) return [];
    const { durationMinutes, slotMinutes, minNoticeMinutes } = this.config.booking;
    const today = this.today();
    const earliest = date === today.date ? today.minutes + (staff ? 0 : minNoticeMinutes) : -1;

    const starts: number[] = [];
    for (let m = toMinutes(hours[0]); m + durationMinutes <= toMinutes(hours[1]); m += slotMinutes) {
      if (m >= earliest || (staff && date === today.date && m + slotMinutes > earliest)) starts.push(m);
    }
    return starts;
  }

  private busyByTable(date: string): Map<string, [number, number][]> {
    const rows = this.db
      .prepare(`SELECT table_id, start_min, end_min FROM bookings WHERE date = ? AND status IN ('confirmed', 'seated')`)
      .all(date) as { table_id: string; start_min: number; end_min: number }[];
    const busy = new Map<string, [number, number][]>();
    for (const r of rows) busy.set(r.table_id, [...(busy.get(r.table_id) ?? []), [r.start_min, r.end_min]]);
    return busy;
  }

  /** Smallest table that fits the party and is free for [start, end). */
  private freeTable(
    busy: Map<string, [number, number][]>,
    start: number,
    end: number,
    partySize: number,
    tableId?: string,
  ): TableConfig | null {
    const candidates = this.config.tables
      .filter((t) => t.seats >= partySize && (!tableId || t.id === tableId))
      .sort((a, b) => a.seats - b.seats);
    return candidates.find((t) => !(busy.get(t.id) ?? []).some(([s, e]) => s < end && e > start)) ?? null;
  }

  private newReference(): string {
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I/L
    for (let attempt = 0; attempt < 10; attempt++) {
      let code = "";
      for (let i = 0; i < 5; i++) code += alphabet[randomInt(alphabet.length)];
      const reference = `${this.config.referencePrefix}-${code}`;
      if (!this.db.prepare(`SELECT 1 FROM bookings WHERE reference = ?`).get(reference)) return reference;
    }
    throw new Error("Could not generate a unique booking reference");
  }

  private toBooking(r: Row): Booking {
    return {
      id: r.id,
      reference: r.reference,
      date: r.date,
      time: fromMinutes(r.start_min),
      endTime: fromMinutes(r.end_min),
      partySize: r.party_size,
      tableId: r.table_id,
      tableName: this.config.tables.find((t) => t.id === r.table_id)?.name ?? r.table_id,
      name: r.name,
      phone: r.phone,
      notes: r.notes,
      status: r.status,
      source: r.source,
      createdAt: r.created_at,
    };
  }
}

/** Keeps digits and a leading "+". Returns "" when it isn't a plausible phone number. */
export function normalizePhone(raw: string): string {
  const cleaned = String(raw).trim().replace(/[\s().-]/g, "");
  return /^\+?\d{7,15}$/.test(cleaned) ? cleaned : "";
}
