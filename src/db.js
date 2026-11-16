'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.NUSKY_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'nusky.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const KARATS = [24, 22, 21, 18];

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','cashier')),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  active INTEGER NOT NULL DEFAULT 1,
  must_change INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rates (
  karat INTEGER PRIMARY KEY,
  sell_rate REAL NOT NULL DEFAULT 0,
  buy_rate REAL NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS rate_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  karat INTEGER NOT NULL,
  sell_rate REAL NOT NULL,
  buy_rate REAL NOT NULL,
  created_at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  karat INTEGER NOT NULL,
  weight_g REAL NOT NULL,
  making_charge REAL NOT NULL DEFAULT 0,
  qty INTEGER NOT NULL DEFAULT 1,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  id_number TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  customer_id INTEGER REFERENCES customers(id),
  subtotal REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  old_gold_value REAL NOT NULL DEFAULT 0,
  net_payable REAL NOT NULL,
  paid_cash REAL NOT NULL DEFAULT 0,
  paid_card REAL NOT NULL DEFAULT 0,
  paid_bank REAL NOT NULL DEFAULT 0,
  cash_tendered REAL NOT NULL DEFAULT 0,
  change_given REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'completed',
  voided_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  item_id INTEGER REFERENCES items(id),
  sku TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  karat INTEGER NOT NULL,
  weight_g REAL NOT NULL,
  rate REAL NOT NULL,
  making_charge REAL NOT NULL DEFAULT 0,
  qty INTEGER NOT NULL DEFAULT 1,
  line_total REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_no TEXT,
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  customer_id INTEGER REFERENCES customers(id),
  total REAL NOT NULL,
  payment_method TEXT NOT NULL,
  sale_id INTEGER REFERENCES sales(id),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'completed',
  voided_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  description TEXT NOT NULL,
  karat INTEGER NOT NULL,
  weight_g REAL NOT NULL,
  rate REAL NOT NULL,
  line_total REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user INTEGER NOT NULL REFERENCES users(id),
  to_user INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message_reads (
  user_id INTEGER NOT NULL,
  thread TEXT NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, thread)
);
CREATE TABLE IF NOT EXISTS customer_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  phone TEXT NOT NULL,
  body TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tv_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_created ON purchases(created_at);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_items_branch ON items(branch_id);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_user, id);
`);

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function now() {
  return new Date().toISOString();
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const DEFAULT_SETTINGS = {
  shop_name: 'Nusky Jewellers',
  shop_address: '',
  shop_phone: '',
  currency: 'Rs.',
  tax_percent: '0',
  receipt_footer: 'Thank you for shopping with Nusky Jewellers.',
  country_code: '94',
  cashier_edit_rate: '0',
  tv_message: 'Welcome to Nusky Jewellers',
  tv_show_pavan: '0',
  tv_show_buy: '0',
  tv_theme: 'royal',
  tv_subtitle: '',
  tv_points: JSON.stringify([
    ['Pure gold', 'Genuine quality'],
    ['Hallmarked', '24K, 22K, 21K and 18K'],
    ['New collections', 'Wedding, festival, traditional'],
  ]),
  sms_gateway_url: '',
};

// The password a new installation starts with. An account still using it is locked to
// "change your password" until it is replaced, so it is never usable on a live system.
const STARTER_PASSWORD = 'admin123';

// Databases created before the forced password change get the new column here.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'must_change')) {
  db.exec('ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0');
  const flag = db.prepare('UPDATE users SET must_change = 1 WHERE id = ?');
  for (const u of db.prepare('SELECT id, salt, pass_hash FROM users').all()) {
    if (hashPassword(STARTER_PASSWORD, u.salt) === u.pass_hash) flag.run(u.id);
  }
}

// First-run seed. Each step is safe to repeat.
tx(() => {
  const setIfMissing = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setIfMissing.run(k, v);

  const rateIfMissing = db.prepare('INSERT OR IGNORE INTO rates (karat, sell_rate, buy_rate) VALUES (?, 0, 0)');
  for (const k of KARATS) rateIfMissing.run(k);

  if (!db.prepare('SELECT id FROM branches LIMIT 1').get()) {
    db.prepare('INSERT INTO branches (name) VALUES (?)').run('Main showroom');
  }
  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
    const salt = crypto.randomBytes(16).toString('hex');
    const branch = db.prepare('SELECT id FROM branches ORDER BY id LIMIT 1').get();
    db.prepare(
      'INSERT INTO users (username, name, pass_hash, salt, role, branch_id, active, must_change, created_at) VALUES (?,?,?,?,?,?,1,1,?)'
    ).run('admin', 'Administrator', hashPassword(STARTER_PASSWORD, salt), salt, 'admin', branch.id, now());
  }
});

module.exports = { db, tx, now, hashPassword, KARATS, DB_PATH, DATA_DIR, DEFAULT_SETTINGS, STARTER_PASSWORD };
