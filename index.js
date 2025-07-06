require('dotenv').config();
const CH_ID = process.env.DISCORD_CHANNEL_ID;
const cron = require('node-cron');
const express = require('express');
const bodyParser = require('body-parser');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionType
} = require('discord.js');

// sheet helpers
const { fetchAllMasterRows, fetchNewBets, markRowSend } = require('./sheets');
// user service
const userService = require('./services/userService');

const app = express();
app.use(bodyParser.json());

// In-memory cache for user settings (discordId => settings)
const userSettingsCache = new Map();

// Webhook endpoint for settings updates
app.post('/settings-updated', async (req, res) => {
  try {
    const { discord_id, staking_mode, bankroll, kelly_pct, flat_stake, stw_amount } = req.body;
    // Persist in DB via userService
    await userService.saveUserSettings(discord_id, { staking_mode, bankroll, kelly_pct, flat_stake, stw_amount });
    // Update cache
    userSettingsCache.set(discord_id, { staking_mode, bankroll, kelly_pct, flat_stake, stw_amount });
    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).send('Error');
  }
});

/**
 * Fetch and post new bets every minute
 */
async function processNewBets() {
  try {
    const newRows = await fetchNewBets();
    // existing logic to post bets to Discord...
  } catch (err) {
    console.error('❌ Error in processNewBets():', err);
  }
}

// Bot setup
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

/**
 * Preload user settings into cache at startup
 */
async function enablePreload() {
  if (typeof userService.getAllUserSettings !== 'function') {
    console.warn('⚠️ userService.getAllUserSettings not defined; skipping preload');
    return;
  }
  try {
    const all = await userService.getAllUserSettings();
    all.forEach(u => userSettingsCache.set(u.discord_id, u));
    console.log(`🔄 Preloaded ${all.length} user settings`);
  } catch(err) {
    console.error('❌ Failed to preload user settings:', err);
  }
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await enablePreload();
  // initial fetch
  await processNewBets();
  // schedule every minute
  cron.schedule('* * * * *', () => {
    console.log('⏱️ Checking for new bets…');
    processNewBets();
  });
});
  await enablePreload();
  // initial fetch
  await processNewBets();
  // schedule every minute
  cron.schedule('* * * * *', () => {
    console.log('⏱️ Checking for new bets…');
    processNewBets();
  });
});

// Interaction handlers
client.on('interactionCreate', async interaction => {
  // ... existing stakeModal and modalSubmit logic using userSettingsCache ...
});

// Login
client.login(process.env.DISCORD_TOKEN).catch(err => console.error('❌ Discord login failed:', err));

// Start webhook listener
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔔 Webhook listening on port ${PORT}`));