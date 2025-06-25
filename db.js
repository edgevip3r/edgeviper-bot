// db.js
const { Pool } = require('pg');

// Make sure PG_CONNECTION matches your Render External Database URL
const pool = new Pool({
  connectionString: process.env.PG_CONNECTION
});

module.exports = pool;