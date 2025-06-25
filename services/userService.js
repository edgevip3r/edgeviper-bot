// services/userService.js
const { fetch } = require('undici');
const BASE       = process.env.WP_API_BASE || 'https://edgeviper.co.uk';
const APP_PASS   = process.env.WP_APP_PASS;
const db         = require('../db');  // Postgres pool

module.exports = {
  /**
   * Fetch user settings from WordPress via REST API
   */
  async findByDiscordId(discordId) {
    const url = `${BASE}/wp-json/ev/v1/user-settings?discord_id=${discordId}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Basic ${Buffer.from(APP_PASS).toString('base64')}`
      }
    });
    if (!res.ok) return null;
    return await res.json();
  },

  /**
   * Load the last saved override stake for a user on a bet
   */
  async getUserBetStake(discordId, betId) {
    console.log(`🔍 [DB] getUserBetStake for ${discordId}, bet ${betId}`);
    const res = await db.query(
      `SELECT stake FROM user_stakes
       WHERE discord_id = $1 AND bet_id = $2`,
      [discordId, betId]
    );
    console.log('🔍 [DB] rows:', res.rows);
    return res.rows[0]?.stake ?? null;
  },

  /**
   * Save or update the user's override stake for a specific bet
   */
  async saveUserBetStake(discordId, betId, stake) {
    console.log(`💾 [DB] saveUserBetStake for ${discordId}, bet ${betId}, stake ${stake}`);
    await db.query(
      `INSERT INTO user_stakes(discord_id, bet_id, stake, updated_at)
       VALUES($1, $2, $3, NOW())
       ON CONFLICT(discord_id, bet_id)
       DO UPDATE SET stake = EXCLUDED.stake,
                     updated_at = EXCLUDED.updated_at`,
      [discordId, betId, stake]
    );
    console.log('💾 [DB] save complete');
  }
};