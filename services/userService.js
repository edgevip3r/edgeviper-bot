// services/userService.js
const { fetch } = require('undici');
const BASE     = process.env.WP_API_BASE || 'https://edgeviper.co.uk';
const APP_PASS = process.env.WP_APP_PASS;
const db       = require('../db');  // Postgres pool

/**
 * Fetch user settings from WordPress via REST API
 */
async function findByDiscordId(discordId) {
  const url = `${BASE}/wp-json/ev/v1/user-settings?discord_id=${discordId}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Basic ${Buffer.from(APP_PASS).toString('base64')}`
    }
  });
  if (!res.ok) return null;
  return await res.json();
}

/**
 * Load the last saved override stake for a user on a bet
 */
async function getUserBetStake(discordId, betId) {
  console.log(`🔍 [DB] getUserBetStake for ${discordId}, bet ${betId}`);
  const res = await db.query(
    `SELECT stake FROM user_stakes
     WHERE discord_id = $1 AND bet_id = $2`,
    [discordId, betId]
  );
  console.log('🔍 [DB] rows:', res.rows);
	return (res.rows[0] && res.rows[0].stake != null)
	  ? parseFloat(res.rows[0].stake)
	  : null;
}

/**
 * Save or update the user's override stake for a specific bet
 */
async function saveUserBetStake(discordId, betId, stake) {
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

/**
 * List all stakes for a given Discord ID
 */
async function listUserStakes(discordId) {
  console.log(`🔍 [DB] listUserStakes for ${discordId}`);
  const res = await db.query(
    `SELECT bet_id, stake FROM user_stakes WHERE discord_id = $1`,
    [discordId]
  );
  console.log('🔍 [DB] stakes rows:', res.rows);
  return res.rows;
}

/**
 * Persist or update a user's betting settings in user_settings table
 */
async function saveUserSettings(discordId, settings) {
  const { staking_mode, bankroll, kelly_pct, flat_stake, stw_amount } = settings;
  console.log(`💾 [DB] saveUserSettings for ${discordId}`, settings);
  await db.query(
    `INSERT INTO user_settings(discord_id, staking_mode, bankroll, kelly_pct, flat_stake, stw_amount, updated_at)
     VALUES($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT(discord_id) DO UPDATE SET
       staking_mode = EXCLUDED.staking_mode,
       bankroll     = EXCLUDED.bankroll,
       kelly_pct    = EXCLUDED.kelly_pct,
       flat_stake   = EXCLUDED.flat_stake,
       stw_amount   = EXCLUDED.stw_amount,
       updated_at   = NOW()`,
    [discordId, staking_mode, bankroll, kelly_pct, flat_stake, stw_amount]
  );
  console.log('💾 [DB] settings save complete');
}

/**
 * Fetch all user betting settings for preload
 */
async function getAllUserSettings() {
  console.log('🔍 [DB] getAllUserSettings');
  const res = await db.query(
    `SELECT discord_id, staking_mode, bankroll, kelly_pct, flat_stake, stw_amount FROM user_settings`);
  console.log('🔍 [DB] all settings rows:', res.rows.length);
  return res.rows;
}

module.exports = {
  findByDiscordId,
  getUserBetStake,
  saveUserBetStake,
  listUserStakes,
  saveUserSettings,
  getAllUserSettings
};