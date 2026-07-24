const { Pool } = require('pg');

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.PGHOST,
      port: parseInt(process.env.PGPORT || '5432', 10),
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl: (process.env.PGSSLMODE === 'disable') ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000
    });
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

// Cliente para transacciones (BEGIN/COMMIT/ROLLBACK).
async function getClient() {
  return getPool().connect();
}

module.exports = { query, getClient };
