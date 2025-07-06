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
// DB-backed user stakes & settings
const userService = require('./services/userService');

// Express for REST endpoints
const app         = express();
const WEBHOOK_KEY = process.env.BOT_WEBHOOK_KEY;
app.use(bodyParser.json());

/**
 * Endpoint: fetch user stakes (for My Bets page)
 */
app.get('/api/user-stakes', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token      = authHeader.replace(/^Bearer\s+/, '');
  if (token !== WEBHOOK_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { discord_id } = req.query;
  if (!discord_id) {
    return res.status(400).json({ error: 'Missing discord_id' });
  }
  try {
    const stakes = await userService.listUserStakes(discord_id);
    return res.json(stakes);
  } catch (err) {
    console.error('Error in /api/user-stakes:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * Endpoint: Discord role sync
 */
app.post('/discord-role', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token      = authHeader.replace(/^Bearer\s+/, '');
  if (token !== WEBHOOK_KEY) return res.status(401).send('Unauthorized');
  const { action, discord_id, role_id, guild_id } = req.body;
  if (!action || !discord_id || !role_id || !guild_id) {
    return res.status(400).send('Missing fields');
  }
  try {
    const guild  = await client.guilds.fetch(guild_id);
    const member = await guild.members.fetch(discord_id);
    if (action === 'add_role') await member.roles.add(role_id);
    else if (action === 'remove_role') await member.roles.remove(role_id);
    else return res.status(400).send('Invalid action');
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Error in /discord-role:', err);
    return res.status(500).send('Server error');
  }
});

/**
 * Webhook: settings updates from WordPress
 */
app.post('/settings-updated', async (req, res) => {
  try {
    const { discord_id, staking_mode, bankroll, kelly_pct, flat_stake, stw_amount } = req.body;
    await userService.saveUserSettings(discord_id, { staking_mode, bankroll, kelly_pct, flat_stake, stw_amount });
    userSettingsCache.set(discord_id, { staking_mode, bankroll, kelly_pct, flat_stake, stw_amount });
    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).send('Error');
  }
});

// In-memory cache for user settings
const userSettingsCache = new Map();

/**
 * Preload all user settings into cache on startup
 */
async function enablePreload() {
  try {
    const all = await userService.getAllUserSettings();
    all.forEach(u => userSettingsCache.set(u.discord_id, u));
    console.log(`🔄 Preloaded ${all.length} user settings`);
  } catch(err) {
    console.error('❌ Failed to preload user settings:', err);
  }
}

/**
 * Lazy-load settings for a single user (fallback)
 */
async function getUserSettings(discordId) {
  if (!userSettingsCache.has(discordId)) {
    const settings = await userService.findByDiscordId(discordId);
    if (settings) userSettingsCache.set(discordId, settings);
  }
  return userSettingsCache.get(discordId);
}

// Discord bot client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers]
});

/**
 * Post new bets and mark them in Google Sheets
 */
async function processNewBets() {
  try {
    const allRows = await fetchAllMasterRows();
    for (let i = 1; i < allRows.length; i++) {
      const row = allRows[i];
      if (row[9] === 'S') {
        const [ date, bookie, sport, event, bet, settleDate ] = row;
        const odds     = parseFloat(row[6]) || 0;
        const fairOdds = parseFloat(row[7]) || 0;
        let   probNum  = parseFloat(row[20]) || 0;
        if (probNum > 1) probNum /= 100;
        const probability = (probNum * 100).toFixed(2) + '%';
        const betId    = row[22] || `row${i}`;
        const valuePct = fairOdds > 0
          ? ((odds / fairOdds) * 100).toFixed(2) + '%'
          : 'N/A';

        const embed = new EmbedBuilder()
          .setColor('#2E7D32')
          .setTitle('💰 New Value Bet 💰')
          .setDescription(`**${sport}** — ${event}`)
          .addFields(
            { name: 'Bookie',      value: bookie,         inline: true },
            { name: 'Odds',        value: odds.toString(), inline: true },
            { name: 'Probability', value: probability,     inline: true },
            { name: 'Bet',         value: bet,            inline: false },
            { name: 'Settles',     value: settleDate,     inline: true },
            { name: 'Value %',     value: valuePct,       inline: true }
          )
          .setTimestamp()
          .setFooter({ text: `Bet ID: ${betId}` });

        const actionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`stakeModal_${betId}`)
            .setLabel('Get / Edit Stake')
            .setStyle(ButtonStyle.Primary)
        );

        const channel = await client.channels.fetch(CH_ID);
        await channel.send({ embeds: [embed], components: [actionRow] });
        await markRowSend(i, 'P');
      }
    }
  } catch (err) {
    console.error('❌ Error in processNewBets():', err);
  }
}

// Interaction handler (modals/buttons)
client.on('interactionCreate', async interaction => {
  if (interaction.isButton() && interaction.customId.startsWith('stakeModal_')) {
    const betId     = interaction.customId.split('_')[1];
    const discordId = interaction.user.id;
    const user      = await getUserSettings(discordId);
    if (!user || !user.staking_mode) {
      return interaction.reply({ content:'❗ Please link Discord first.', flags:64 });
    }

    // Lookup bet row
    const all       = await fetchAllMasterRows();
    const header    = all[0] || [];
    const idxId     = header.indexOf('Bet ID');
    const idxOdds   = header.indexOf('Odds');
    const idxProb   = header.indexOf('Probability');
    const row       = all.slice(1).find(r => r[idxId]?.toString() === betId);
    if (!row) {
      return interaction.reply({ content:'❌ Bet not found.', flags:64 });
    }
    const odds     = parseFloat(row[idxOdds]) || 0;
    let   prob     = parseFloat(row[idxProb]) || 0;
    if (prob > 1) prob /= 100;

    // Calculate recommended stake
    let recommended;
    if (user.staking_mode === 'flat') {
      recommended = user.flat_stake;
    } else if (user.staking_mode === 'stw') {
      const raw   = user.stw_amount / (odds - 1) || 0;
      let   stake = Math.round(raw);
      if (stake * (odds - 1) < user.stw_amount) stake += 1;
      recommended = stake;
    } else {
      const pct = Math.min(user.kelly_pct,100) / 100;
      recommended = Math.floor(((odds * prob - 1) / (odds - 1)) * user.bankroll * pct);
    }

    // Fetch previous override
    const previous = await userService.getUserBetStake(discordId, betId);
    const prevNum  = (previous != null && !isNaN(previous)) ? previous : null;
    const defaultOverride = prevNum != null ? prevNum.toFixed(2) : '';

    // Show modal
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

// Bot ready: preload settings, post new bets, schedule
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await enablePreload();
  await processNewBets();
  cron.schedule('* * * * *', () => {
    console.log('⏱️ Checking for new bets…');
    processNewBets();
  });
});

// Log in and start webhook listener
client.login(process.env.DISCORD_TOKEN).catch(err => console.error('❌ Discord login failed:', err));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔔 Webhook listener on port ${PORT}`));