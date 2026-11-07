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
