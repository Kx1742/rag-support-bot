import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Each migration runs once; PRAGMA user_version records how many have run. */
const MIGRATIONS = [
  `
  CREATE TABLE menu_items (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    category  TEXT NOT NULL,
    price     INTEGER NOT NULL CHECK (price >= 0),
    available INTEGER NOT NULL DEFAULT 1,
    active    INTEGER NOT NULL DEFAULT 1,
    sort      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE bookings (
    id         INTEGER PRIMARY KEY,
    reference  TEXT NOT NULL UNIQUE,
    date       TEXT NOT NULL,
    start_min  INTEGER NOT NULL,
    end_min    INTEGER NOT NULL,
    party_size INTEGER NOT NULL CHECK (party_size > 0),
    table_id   TEXT NOT NULL,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL,
    source     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX bookings_by_date ON bookings (date, status);
  CREATE INDEX bookings_by_phone ON bookings (phone, date);

  CREATE TABLE orders (
    id            INTEGER PRIMARY KEY,
    number        INTEGER NOT NULL,
    business_date TEXT NOT NULL,
    type          TEXT NOT NULL,
    table_id      TEXT,
    customer_name TEXT NOT NULL DEFAULT '',
    notes         TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL,
    total         INTEGER NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (business_date, number)
  );

  CREATE TABLE order_items (
    id         INTEGER PRIMARY KEY,
    order_id   INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    item_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    unit_price INTEGER NOT NULL,
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    note       TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX order_items_by_order ON order_items (order_id);
  `,
  // 2: staff accounts & roles, drink options, payments, duplicate-order protection
  `
  CREATE TABLE staff (
    id              INTEGER PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('manager', 'staff')),
    pin_hash        TEXT NOT NULL,
    active          INTEGER NOT NULL DEFAULT 1,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  ALTER TABLE order_items ADD COLUMN options TEXT NOT NULL DEFAULT '[]';

  ALTER TABLE orders ADD COLUMN client_ref TEXT;
  CREATE UNIQUE INDEX orders_by_client_ref ON orders (client_ref) WHERE client_ref IS NOT NULL;
  ALTER TABLE orders ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
  ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid';
  ALTER TABLE orders ADD COLUMN payment_method TEXT;
  ALTER TABLE orders ADD COLUMN amount_tendered INTEGER;
  ALTER TABLE orders ADD COLUMN paid_at TEXT;
  ALTER TABLE orders ADD COLUMN paid_by TEXT;
  ALTER TABLE orders ADD COLUMN refunded_at TEXT;
  ALTER TABLE orders ADD COLUMN refunded_by TEXT;
  ALTER TABLE orders ADD COLUMN refund_reason TEXT;
  `,
  // 3: menu editing in the desk + stock counts
  `
  ALTER TABLE menu_items ADD COLUMN options TEXT;                        -- JSON list of option group ids
  ALTER TABLE menu_items ADD COLUMN stock INTEGER;                       -- NULL = not counted
  ALTER TABLE menu_items ADD COLUMN edited INTEGER NOT NULL DEFAULT 0;   -- 1 = changed in the desk, shop.json no longer overrides it
  ALTER TABLE menu_items ADD COLUMN origin TEXT NOT NULL DEFAULT 'file'; -- 'file' (shop.json) or 'desk'
  `,
  // 4: loyalty program + order ahead
  `
  CREATE TABLE loyalty_members (
    id            INTEGER PRIMARY KEY,
    phone         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    points        INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
    lifetime      INTEGER NOT NULL DEFAULT 0,
    last_activity TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  -- Every change to a balance, so points can always be explained.
  CREATE TABLE loyalty_ledger (
    id         INTEGER PRIMARY KEY,
    member_id  INTEGER NOT NULL REFERENCES loyalty_members (id),
    order_id   INTEGER REFERENCES orders (id),
    delta      INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    by_name    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX loyalty_ledger_by_member ON loyalty_ledger (member_id, id);

  ALTER TABLE orders ADD COLUMN member_id INTEGER REFERENCES loyalty_members (id);
  ALTER TABLE orders ADD COLUMN subtotal INTEGER;
  ALTER TABLE orders ADD COLUMN discount INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE orders ADD COLUMN reward_id TEXT;
  ALTER TABLE orders ADD COLUMN reward_name TEXT;
  ALTER TABLE orders ADD COLUMN points_redeemed INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE orders ADD COLUMN points_earned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'till';
  ALTER TABLE orders ADD COLUMN pickup_time TEXT;
  ALTER TABLE orders ADD COLUMN customer_phone TEXT NOT NULL DEFAULT '';
  `,
];

/** Opens (or creates) a SQLite database and brings its schema up to date. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let i = version; i < MIGRATIONS.length; i++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  return db;
}

/** Runs fn inside BEGIN IMMEDIATE ... COMMIT, rolling back on error. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
