require('dotenv').config();
const CH_ID       = process.env.DISCORD_CHANNEL_ID;
const cron        = require('node-cron');
const express     = require('express');
const bodyParser  = require('body-parser');
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

// In-memory cache for user settings (discordId => settings)
const userSettingsCache = new Map();

// Express app for webhooks or other endpoints
const app = express();
app.use(bodyParser.json());

// Discord bot client
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

/**
 * Lazy-load user settings into cache
 */
async function getUserSettings(discordId) {
  if (!userSettingsCache.has(discordId)) {
    const settings = await userService.findByDiscordId(discordId);
    userSettingsCache.set(discordId, settings);
  }
  return userSettingsCache.get(discordId);
}

// Process new bets logic (unchanged)...
async function processNewBets() {
  try {
    const newRows = await fetchNewBets();
    // existing logic to post bets...
  } catch (err) {
    console.error('❌ Error in processNewBets():', err);
  }
}

// Interaction handler (modals/buttons)
client.on('interactionCreate', async interaction => {
  if (interaction.isButton() && interaction.customId.startsWith('stakeModal_')) {
    const betId     = interaction.customId.split('_')[1];
    const discordId = interaction.user.id;

    // 1) Fetch user settings from cache or service
// inside your button handler, before calling showModal()
const start = process.hrtime.bigint();
    const user = await getUserSettings(discordId);
// … compute `recommended` …
const diff = Number(process.hrtime.bigint() - start)/1e6;
console.log(`Lookup+calc took ${diff.toFixed(2)} ms`);
    if (!user) {
      return interaction.reply({ content:'❗ Please link Discord first.', flags:64 });
    }

    // 2) Fetch sheet rows and find the bet entry (unchanged)
    const all = await fetchAllMasterRows();
    const header = all[0] || [];
    const idxId   = header.indexOf('Bet ID');
    const idxOdds = header.indexOf('Odds');
    const idxProb = header.indexOf('Probability');
    const row     = all.slice(1).find(r => r[idxId]?.toString() === betId);
    if (!row) {
      return interaction.reply({ content:'❌ Bet not found.', flags:64 });
    }

    // 3) Compute recommended stake synchronously using user settings
    const odds = parseFloat(row[idxOdds]) || 0;
    let prob = parseFloat(row[idxProb]) || 0;
    if (prob > 1) prob /= 100;

    let recommended;
    if (user.staking_mode === 'flat') {
      recommended = user.flat_stake;
    } else if (user.staking_mode === 'kelly') {
      const k = Math.min(user.kelly_pct / 100, 1);
      recommended = Math.floor(((odds * prob - 1) / (odds - 1)) * user.bankroll * k);
    } else {
      // stake-to-win
      const raw = (user.stw_amount || 0) / (odds - 1) || 0;
      recommended = Math.round(raw);
      if (recommended * (odds - 1) < user.stw_amount) recommended++;
    }

    // previous override fetch (unchanged)
    const prev = await userService.getUserBetStake(discordId, betId);
    const defaultOverride = prev != null ? prev.toFixed(2) : '';

    // 4) Show the modal immediately with precomputed recommended value
    const modal = new ModalBuilder()
      .setCustomId(`stakeModalSubmit_${betId}`)
      .setTitle('Your Stake Calculator')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('recommended')
            .setLabel('Recommended Stake')
            .setStyle(TextInputStyle.Short)
            .setValue(recommended.toFixed(2))
            .setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('override')
            .setLabel('Actual Stake (optional)')
            .setStyle(TextInputStyle.Short)
            .setValue(defaultOverride)
            .setRequired(false)
        )
      );

    return interaction.showModal(modal);
  }

  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('stakeModalSubmit_')) {
    const betId     = interaction.customId.split('_')[1];
    const discordId = interaction.user.id;
    const recStr    = interaction.fields.getTextInputValue('recommended');
    const overStr   = interaction.fields.getTextInputValue('override');
    const finalStake= parseFloat(overStr) || parseFloat(recStr);

    await userService.saveUserBetStake(discordId, betId, finalStake);
    return interaction.reply({ content:`💵 You’ve staked **£${finalStake.toFixed(2)}** on Bet ${betId}`, flags:64 });
  }
});

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await processNewBets();
  cron.schedule('* * * * *', () => {
    console.log('⏱️ Checking for new bets…');
    processNewBets();
  });
});

client.login(process.env.DISCORD_TOKEN).catch(err => console.error('❌ Discord login failed:', err));

// Start Express listener
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔔 Webhook listener on port ${PORT}`));