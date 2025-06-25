// index.js
require('dotenv').config();
const CH_ID    = process.env.DISCORD_CHANNEL_ID;
const cron     = require('node-cron');
const express  = require('express');
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
// DB-backed user stakes
const userService = require('./services/userService');

// Express for MemberPress role sync
const app        = express();
const WEBHOOK_KEY = process.env.BOT_WEBHOOK_KEY;
app.use(bodyParser.json());

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
    console.error('Discord role sync error:', err);
    return res.status(500).send('Server error');
  }
});

// Discord bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

// Post new bets and mark them
async function processNewBets() {
  try {
    const rows = await fetchNewBets();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      // unpack
      const [ date, bookie, sport, event, bet, settleDate ] = row;
      const odds        = parseFloat(row[6]);
      const fairOdds    = parseFloat(row[7]);
      const probability = row[20];
      const betId       = row[22] || `row${i}`;
      const valuePct = fairOdds > 0 ? ((odds / fairOdds)*100).toFixed(2)+'%' : 'N/A';

      const embed = new EmbedBuilder()
        .setColor('#2E7D32')
        .setTitle('💰 New Value Bet 💰')
        .setDescription(`**${sport}** — ${event}`)
        .addFields(
          { name:'Bookie', value:bookie, inline:true },
          { name:'Odds',   value:odds.toString(), inline:true },
          { name:'Probability', value:probability, inline:true },
          { name:'Bet',    value:bet },
          { name:'Settles', value:settleDate, inline:true },
          { name:'Value %', value:valuePct, inline:true }
        )
        .setTimestamp()
        .setFooter({ text:`Bet ID: ${betId}` });

      const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`stakeModal_${betId}`)
          .setLabel('Get / Edit Stake')
          .setStyle(ButtonStyle.Primary)
      );

      const channel = await client.channels.fetch(CH_ID);
      await channel.send({ embeds:[embed], components:[actionRow] });
      await markRowSend(i, 'P');
    }
  } catch (err) {
    console.error('❌ Error in processNewBets():', err);
  }
}

// Interaction handler
client.on('interactionCreate', async interaction => {
  // Button click: show modal
  if (interaction.isButton() && interaction.customId.startsWith('stakeModal_')) {
    const betId = interaction.customId.split('_')[1];
    const discordId = interaction.user.id;
    const user = await userService.findByDiscordId(discordId);
    if (!user) {
      return interaction.reply({ content:'❗ Please link your Discord in your account first.', flags:64 });
    }
    // lookup the bet row by ID
    const all = await fetchAllMasterRows();
    const header = all[0] || [];
    const idxId   = header.indexOf('Bet ID');
    const idxOdds = header.indexOf('Odds');
    const idxProb = header.indexOf('Probability');
    const row     = all.slice(1).find(r => r[idxId]?.toString() === betId);
    if (!row) {
      return interaction.reply({ content:'❌ Bet not found.', flags:64 });
    }
    const odds = parseFloat(row[idxOdds]);
    let prob = parseFloat(row[idxProb]); if (prob > 1) prob /= 100;
    let recommended;
    if (user.staking_mode === 'flat') recommended = user.flat_amount;
    else {
      const pct = Math.min(user.kelly_pct,100)/100;
      recommended = Math.floor(((odds*prob-1)/(odds-1))*user.bankroll*pct);
    }
    const previous = await userService.getUserBetStake(discordId, betId);
// parseFloat handles the fact that PG returns numbers as strings
const prevNum = previous != null && !isNaN(previous)
  ? parseFloat(previous)
  : null;
const defaultOverride = prevNum != null
  ? prevNum.toFixed(2)
  : '';
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
  // Modal submit: save
  if (interaction.type===InteractionType.ModalSubmit && interaction.customId.startsWith('stakeModalSubmit_')) {
    const betId = interaction.customId.split('_')[1];
    const discordId = interaction.user.id;
    const recStr = interaction.fields.getTextInputValue('recommended');
    const overStr= interaction.fields.getTextInputValue('override');
    const finalStake = parseFloat(overStr) || parseFloat(recStr);
    await userService.saveUserBetStake(discordId, betId, finalStake);
    return interaction.reply({ content:`💵 You’ve staked **£${finalStake.toFixed(2)}** on Bet ${betId}`, flags:64 });
  }
});

// Ready & cron
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await processNewBets();
  cron.schedule('0 * * * * *', () => {
    console.log('⏱️ Checking for new bets…');
    processNewBets();
  });
});

client.login(process.env.DISCORD_TOKEN)
  .catch(err => console.error('❌ Discord login failed:', err));

// Start Express listener
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔔 Webhook listener on port ${PORT}`));