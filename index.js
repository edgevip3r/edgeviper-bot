// index.js

require('dotenv').config();

const Redis       = require('ioredis');
const redis       = new Redis(process.env.REDIS_URL);
redis.on('error', err => console.error('Redis error:', err));

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
const { fetchAllMasterRows, markRowSend } = require('./sheets');
// DB-backed user stakes & settings
const userService = require('./services/userService');

// Express for REST endpoints
const app         = express();
const WEBHOOK_KEY = process.env.BOT_WEBHOOK_KEY;
app.use(bodyParser.json());

// In-memory cache for user settings
const userSettingsCache = new Map();
// Redis key for posted bets dedupe
const POSTED_BET_SET    = 'postedBets';

/**
 * Endpoint: fetch user stakes (for My Bets page)
 */
app.get('/api/user-stakes', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (token !== WEBHOOK_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { discord_id } = req.query;
  if (!discord_id) return res.status(400).json({ error: 'Missing discord_id' });
  try {
    const stakes = await userService.listUserStakes(discord_id);
    return res.json(stakes);
  } catch (err) {
    console.error('Error in /api/user-stakes:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * Role sync endpoint
 */
app.post('/discord-role', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (token !== WEBHOOK_KEY) return res.status(401).send('Unauthorized');
  const { action, discord_id, role_id, guild_id } = req.body;
  if (!action || !discord_id || !role_id || !guild_id) return res.status(400).send('Missing fields');
  try {
    const guild  = await client.guilds.fetch(guild_id);
    const member = await guild.members.fetch(discord_id);
    if (action === 'add_role')    await member.roles.add(role_id);
    else if (action === 'remove_role') await member.roles.remove(role_id);
    else return res.status(400).send('Invalid action');
    return res.sendStatus(200);
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
    const settings = { staking_mode, bankroll, kelly_pct, flat_stake, stw_amount };
    await userService.saveUserSettings(discord_id, settings);
    await redis.hset('user_settings', discord_id, JSON.stringify(settings));
    userSettingsCache.set(discord_id, settings);
    console.log(`🔄 [Redis] user_settings updated for ${discord_id}`);
    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).send('Error');
  }
});

/**
 * Preload all user settings from Redis into in-memory cache
 */
async function enablePreload() {
  try {
    const all = await redis.hgetall('user_settings');
    for (const [id, json] of Object.entries(all)) {
      userSettingsCache.set(id, JSON.parse(json));
    }
    console.log(`🔄 Preloaded ${Object.keys(all).length} user settings from Redis`);
  } catch (err) {
    console.error('❌ Failed to preload user settings:', err);
  }
}

/**
 * Lazy-load settings: memory -> Redis -> WordPress REST
 */
async function getUserSettings(discordId) {
  if (!userSettingsCache.has(discordId)) {
    const raw = await redis.hget('user_settings', discordId);
    if (raw) {
      const parsed = JSON.parse(raw);
      userSettingsCache.set(discordId, parsed);
    } else {
      const settings = await userService.findByDiscordId(discordId);
      if (settings) {
        await redis.hset('user_settings', discordId, JSON.stringify(settings));
        userSettingsCache.set(discordId, settings);
      }
    }
  }
  return userSettingsCache.get(discordId);
}

/**
 * Post new bets and mark them in Google Sheets
 */
async function processNewBets() {
  try {
    const rows = await fetchAllMasterRows();
    for (let i = 1; i < rows.length; i++) {
      const r     = rows[i];
      const betId = r[22] || `row${i}`;

      if (r[9] !== 'S') continue;
      const already = await redis.sismember(POSTED_BET_SET, betId);
      if (already) continue;

      const [ date, bookie, sport, event, betText, settleDate ] = r;
      const odds     = parseFloat(r[6]) || 0;
      const fairOdds = parseFloat(r[7]) || 0;
      const valuePct = fairOdds > 0
        ? ((odds / fairOdds) * 100).toFixed(2) + '%'
        : 'N/A';

      // Calculate Min Odds
      const rawMinOdds = fairOdds * 1.05; // 105% threshold
      const minOdds    = Math.floor(rawMinOdds * 100) / 100;

      const embed = new EmbedBuilder()
        .setColor('#2E7D32')
        .setTitle('💰 New Value Bet 💰')
        .setDescription(`**${sport}** — ${event}`)
        .addFields(
          { name: 'Bookie',    value: bookie,               inline: true },
          { name: 'Odds',      value: odds.toString(),      inline: true },
          { name: 'Min Odds',  value: minOdds.toFixed(2),   inline: true },
          { name: 'Fair Odds', value: fairOdds.toFixed(2),  inline: true },
          { name: 'Value %',   value: valuePct,             inline: true },
          { name: 'Bet',       value: betText,              inline: false },
          { name: 'Settles',   value: settleDate,           inline: true }
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
      await redis.sadd(POSTED_BET_SET, betId);
      await redis.expire(POSTED_BET_SET, 86400);
    }
  } catch (err) {
    console.error('❌ Error in processNewBets():', err);
  }
}

// Interaction handler (buttons & modals)
client.on('interactionCreate', async interaction => {
  // 1) Show stake modal
  if (interaction.isButton() && interaction.customId.startsWith('stakeModal_')) {
    const betId     = interaction.customId.split('_')[1];
    const discordId = interaction.user.id;
    const startTime = process.hrtime();

    const user      = await getUserSettings(discordId);
    if (!user || !user.staking_mode) {
      return interaction.reply({ content: '❗ Please link Discord first.', flags: 64 });
    }

    // find row in sheet
    const all    = await fetchAllMasterRows();
    const header = all[0] || [];
    const idxId  = header.indexOf('Bet ID');
    const idxO   = header.indexOf('Odds');
    const row    = all.slice(1).find(r => r[idxId]?.toString() === betId);
    if (!row) return interaction.reply({ content: '❌ Bet not found.', flags: 64 });

    const odds     = parseFloat(row[idxO]) || 0;
    let   pVal     = parseFloat(row[ header.indexOf('Probability') ]) || 0;
    if (pVal > 1) pVal /= 100;

    // calculate recommended stake
    let recommendedNum = 0;
    const bankrollNum  = parseFloat(user.bankroll) || 0;
    const kellyPctNum  = Math.min(parseFloat(user.kelly_pct)||0,100)/100;
    const flatNum      = parseFloat(user.flat_stake)    || 0;
    const stwNum       = parseFloat(user.stw_amount)    || 0;

    if (user.staking_mode === 'flat') {
      recommendedNum = flatNum;
    }
    else if (user.staking_mode === 'stw') {
      let raw = stwNum/(odds-1) || 0;
      let sk  = Math.round(raw);
      if (sk*(odds-1) < stwNum) sk++;
      recommendedNum = sk;
    }
    else {
      recommendedNum = Math.floor(((odds*pVal - 1)/(odds-1)) * bankrollNum * kellyPctNum);
    }
    const recommended    = Number.isFinite(recommendedNum) ? recommendedNum : 0;
    const prevVal        = await userService.getUserBetStake(discordId, betId);
    const defaultOverride= prevVal!=null && !isNaN(prevVal) ? prevVal.toFixed(2) : '';

    // Tip #1: fetch any saved odds override
    const existingBet    = await userService.getUserBet(discordId, betId);

    // build and show modal
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
            .setLabel('Actual Stake (Optional)')
            .setStyle(TextInputStyle.Short)
            .setValue(defaultOverride)
            .setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('odds_override')
            .setLabel('Odds Override (Optional)')
            .setStyle(TextInputStyle.Short)
            .setValue(existingBet?.odds?.toFixed(2) || null)
            .setPlaceholder(existingBet ? null : odds.toFixed(2))
            .setRequired(false)
        )
      );
    return interaction.showModal(modal);
  }

  // 2) Handle modal submit
  if (interaction.type === InteractionType.ModalSubmit &&
      interaction.customId.startsWith('stakeModalSubmit_')) {

    const betId    = interaction.customId.split('_')[1];
    const discordId= interaction.user.id;

    // parse stakes
    const recStr   = interaction.fields.getTextInputValue('recommended');
    const overStr  = interaction.fields.getTextInputValue('override');
    const finalStake = parseFloat(overStr) || parseFloat(recStr);

    // Tip #2: parse odds override
    const oddsStr      = interaction.fields.getTextInputValue('odds_override');
    const oddsOverride = oddsStr ? parseFloat(oddsStr) : null;

    // determine final odds, fallback to saved or null
    let finalOdds = oddsOverride;
    if (finalOdds === null) {
      const existing = await userService.getUserBet(discordId, betId);
      finalOdds      = existing?.odds ?? null;
    }

    // save both stake & odds
    await userService.saveUserBetStake(discordId, betId, finalStake, finalOdds);

    // respond ephemerally for testing
    return interaction.reply({
      content: `💵 You’ve staked **£${finalStake.toFixed(2)}** at **${finalOdds?.toFixed(2) || 'N/A'}** on Bet ${betId}`,
      flags: 64
    });
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

// Login & webhook listener
client.login(process.env.DISCORD_TOKEN).catch(err => console.error('❌ Discord login failed:', err));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔔 Webhook listener on port ${PORT}`));