// db.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.PG_CONNECTION,
  ssl: { rejectUnauthorized: false }   // ← add this block
});

module.exports = pool;