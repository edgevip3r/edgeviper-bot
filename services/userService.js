const { fetch } = require('undici');
const BASE  = process.env.WP_API_BASE || 'https://edgeviper.co.uk';
const APP_PASS = process.env.WP_APP_PASS;

module.exports = {
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
  async getUserBetStake(userId, betId) { return null; },
  async saveUserBetStake(userId, betId, stake) { /* … */ }
};