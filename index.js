require('dotenv').config();

const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);
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
const {
  getUserBetOddsOverride,
  saveUserBetOddsOverride
} = userService;

// Express for REST endpoints
const app = express();
const WEBHOOK_KEY = process.env.BOT_WEBHOOK_KEY;
app.use(bodyParser.json());

// In-memory cache for user settings
const userSettingsCache = new Map();

// Redis set key for posted bets dedupe
const POSTED_BET_SET = 'postedBets';

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
 * Endpoint: Discord role sync
 */
app.post('/discord-role', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (token !== WEBHOOK_KEY) return res.status(401).send('Unauthorized');
  const { action, discord_id, role_id, guild_id } = req.body;
  if (!action || !discord_id || !role_id || !guild_id) return res.status(400).send('Missing fields');
  try {
    const guild  = await client.guilds.fetch(guild_id);
    const member = await guild.members.fetch(discord_id);
    if (action === 'add_role') await member.roles.add(role_id);
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
    console.log(`🔄 [Redis] user_settings updated for ${discord_id}: ${JSON.stringify(settings)}`);
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
    const count = Object.keys(all).length;
    for (const [id, json] of Object.entries(all)) {
      userSettingsCache.set(id, JSON.parse(json));
    }
    console.log(`🔄 Preloaded ${count} user settings from Redis`);
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

// Discord bot client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

/**
 * Post new bets and mark them in Google Sheets
 */
async function processNewBets() {
  try {
    // === MASTERBETS CACHE BUILD ===
    const all         = await fetchAllMasterRows();
    const header      = all[0] || [];
    const dataRows    = all.slice(1);
    global.masterBets = new Map(
      dataRows.map(r => {
        const obj = {};
        header.forEach((col, i) => {
          obj[col.trim()] = r[i];
        });
        const key = String(obj['Bet ID'] || '').replace(/,/g, '');
        return [key, obj];
      })
    );
    // === END CACHE BUILD ===
    const rows = await fetchAllMasterRows();
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const betId = r[22] || `row${i}`;
      if (r[9] !== 'S') continue;
      const already = await redis.sismember(POSTED_BET_SET, betId);
      if (already) continue;

      // Destructure main fields and pull URL from new column X (index 23)
      const [ date, bookie, sport, event, betText, settleDate ] = r;
      const bookieUrl = r[23] || '';
      const odds     = parseFloat(r[6]) || 0;
      const fairOdds = parseFloat(r[7]) || 0;
      const valueThreshold = 105;
      const rawMinOdds     = fairOdds * (valueThreshold/100);
      const minOdds        = Math.floor(rawMinOdds * 100) / 100;
      const valuePct = fairOdds > 0
        ? ((odds / fairOdds) * 100).toFixed(2) + '%'
        : 'N/A';

      // Build embed, making Bookie name a hyperlink if URL provided
      const embed = new EmbedBuilder()
        .setColor('#2E7D32')
        .setTitle('💰 New Value Bet 💰')
        .setDescription(`**${sport}** — ${event}`)
        .addFields(
          {
            name: 'Bookie',
            value: bookieUrl ? `[${bookie}](${bookieUrl})` : bookie,
            inline: true
          },
          { name: 'Odds',        value: odds.toString(),          inline: true },
          { name: 'Min Odds',    value: minOdds.toFixed(2),       inline: true },
          { name: 'Bet',         value: betText,                  inline: false },
          { name: 'Settles',     value: settleDate,              inline: true },
          { name: 'Value %',     value: valuePct,                inline: true },
          { name: 'Fair Odds',   value: fairOdds.toFixed(2),     inline: true }
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

client.on('interactionCreate', async interaction => {
  // ── BUTTON CLICK: build & show modal ──
  if (interaction.isButton() && interaction.customId.startsWith('stakeModal_')) {
    // Normalize Bet ID
    const raw       = interaction.customId.split('_')[1];
    const betId     = raw.replace(/,/g, '');
    const discordId = interaction.user.id;

    // Load user settings
    const user = await getUserSettings(discordId);
    if (!user || !user.staking_mode) {
      return interaction.reply({ content: '❗ Please link Discord first.', flags: 64 });
    }

    // Lookup master row
    const masterRow = global.masterBets.get(betId);
    if (!masterRow) {
      return interaction.reply({
        content: `❌ Bet ${raw} not found. Please try again.`,
        flags: 64
      });
    }

    // Parse original odds & probability
    const originalOdds = parseFloat(masterRow['Odds']) || 0;
    let   pVal         = parseFloat(masterRow['Probability']) || 0;
    if (pVal > 1) pVal /= 100;

    // Pull any saved override and choose which odds to use
	const prevOddsOverride = await getUserBetOddsOverride(discordId, betId);
	// prevOddsOverride is now a Number or null
	const defaultOddsOverride = prevOddsOverride != null
	  ? prevOddsOverride.toFixed(2)
	  : '';
    const useOdds = prevOddsOverride != null ? prevOddsOverride : originalOdds;

    // Calculate recommended stake using useOdds
    let recommendedNum = 0;
    const bankrollNum = parseFloat(user.bankroll)  || 0;
    const kellyPctNum = Math.min(parseFloat(user.kelly_pct)||0, 100) / 100;
    const flatNum     = parseFloat(user.flat_stake) || 0;
    const stwNum      = parseFloat(user.stw_amount) || 0;

    if (user.staking_mode === 'flat') {
      recommendedNum = flatNum;
    } else if (user.staking_mode === 'stw') {
      let rawStw = stwNum / (useOdds - 1) || 0;
      let sk     = Math.round(rawStw);
      if (sk * (useOdds - 1) < stwNum) sk++;
      recommendedNum = sk;
    } else {
      // Kelly
      recommendedNum = Math.floor(
        ((useOdds * pVal - 1) / (useOdds - 1)) * bankrollNum * kellyPctNum
      );
    }

    const recommended = Number.isFinite(recommendedNum) ? recommendedNum : 0;

    // Fetch any previously saved stake override & notes
    const prevVal          = await userService.getUserBetStake(discordId, betId);
    const defaultOverride  = prevVal != null && !isNaN(prevVal)
      ? prevVal.toFixed(2)
      : '';

    const prevNotes        = await userService.getUserBetNotes(discordId, betId);
    const defaultNotes     = prevNotes || '';

    // Build and show modal
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
        ),
        // === ODDS OVERRIDE ===
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('oddsOverride')
            .setLabel('Odds Override (optional)')
            .setStyle(TextInputStyle.Short)
            .setValue(defaultOddsOverride)
            .setRequired(false)
        ),
        // === NOTES ===
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('notes')
            .setLabel('Notes (optional)')
            .setStyle(TextInputStyle.Short)
            .setValue(defaultNotes)
            .setRequired(false)
        )
      );

    return interaction.showModal(modal);
  }

  // ── MODAL SUBMIT: handle values & saving ──
  if (
    interaction.type === InteractionType.ModalSubmit &&
    interaction.customId.startsWith('stakeModalSubmit_')
  ) {
    const raw       = interaction.customId.split('_')[1];
    const betId     = raw.replace(/,/g, '');
    const discordId = interaction.user.id;

    // Gather modal inputs
    const recStr    = interaction.fields.getTextInputValue('recommended');
    const overStr   = interaction.fields.getTextInputValue('override');
    const oddsStr   = interaction.fields.getTextInputValue('oddsOverride');
    const notesStr  = interaction.fields.getTextInputValue('notes');

    // Parse values
    const finalStake        = parseFloat(overStr) || parseFloat(recStr);
    const finalOddsOverride = oddsStr ? parseFloat(oddsStr) : null;
    const notes             = notesStr ?? '';
	
	// ── Fetch original odds for feedback ──
	let originalOdds = 0;
	if (global.masterBets) {
	  const masterRow = global.masterBets.get(betId);
	  if (masterRow) {
		originalOdds = parseFloat(masterRow['Odds']) || 0;
	  }
	}

    // (You already have originalOdds, prevOverride, useOdds logic if needed for messaging)

    // Branch & save
    const prevOverride = await getUserBetOddsOverride(discordId, betId);
    const userSettings = await getUserSettings(discordId);
    const stakeType    = userSettings.staking_mode;

    // Flat always logs
    if (stakeType === 'flat') {
      await userService.saveUserBetStake(discordId, betId, finalStake, finalOddsOverride, notes);
      return interaction.reply({
        content: `💵 You’ve staked **£${finalStake.toFixed(2)}** on Bet ${betId}`,
        flags: 64
      });
    }

    // STW/Kelly first-time override
    if ((stakeType === 'stw' || stakeType === 'kelly') &&
        prevOverride == null && finalOddsOverride !== null) {
      await saveUserBetOddsOverride(discordId, betId, finalOddsOverride);
      return interaction.reply({
        content: `🔄 Odds override saved from **${originalOdds.toFixed(2)}** to **${finalOddsOverride.toFixed(2)}**. Please reopen to see your updated stake.`,
        flags: 64
      });
    }

    // STW/Kelly subsequent override change
    if ((stakeType === 'stw' || stakeType === 'kelly') &&
        prevOverride != null && finalOddsOverride !== prevOverride) {
      await saveUserBetOddsOverride(discordId, betId, finalOddsOverride);
      return interaction.reply({
        content: `🔄 Odds override updated from **${prevOverride.toFixed(2)}** to **${finalOddsOverride.toFixed(2)}**. Please reopen to see the new stake.`,
        flags: 64
      });
    }

    // c) Final log
    await userService.saveUserBetStake(discordId, betId, finalStake, finalOddsOverride, notes);
    return interaction.reply({
      content: `💵 You’ve staked **£${finalStake.toFixed(2)}** on Bet ${betId}`,
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
client.login(process.env.DISCORD_TOKEN).catch(err=>console.error('❌ Discord login failed:',err));
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`🔔 Webhook listener on port ${PORT}`));

module.exports = app;