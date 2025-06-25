// index.js
require('dotenv').config();
const CH_ID = process.env.DISCORD_CHANNEL_ID;
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
console.log('⚙️  Flags import:', InteractionResponseFlags);
const { fetchMasterRows, markRowSend } = require('./sheets');
const userService = require('./services/userService');

//
// —— Constants for column indexes (zero‐based) ——
//
const SEND_COL   = 9;   // “S” in column J
const BETID_COL  = 22;  // your Bet ID in column W
const ODDS_COL   = 6;   // column G
const FAIR_COL   = 7;   // column H (for value % if needed)
const PROB_COL   = 20;  // column U

//
// —— Express webhook for MemberPress role sync ——
//
const app        = express();
app.use(bodyParser.json());
const WEBHOOK_KEY = process.env.BOT_WEBHOOK_KEY;

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

    if (action === 'add_role') {
      await member.roles.add(role_id);
    } else if (action === 'remove_role') {
      await member.roles.remove(role_id);
    } else {
      return res.status(400).send('Invalid action');
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Discord role sync error:', err);
    return res.status(500).send('Server error');
  }
});

//
// —— Discord bot setup ——
//
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers
  ]
});

//
// —— Helper to find a sheet row by Bet ID ——
//
async function findSheetRowByBetId(betId) {
  const rows = await fetchMasterRows();
  return rows.find(r => (r[BETID_COL]||'').toString() === betId.toString());
}

//
// —— Main posting loop ——
//
async function processNewBets() {
  try {
    const rows = await fetchMasterRows();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row[SEND_COL] === 'S') {
        // extract columns
        const [ date, bookie, sport, event, bet, settleDate ] = row;
        const odds        = parseFloat(row[ODDS_COL]);
        const fairOdds    = parseFloat(row[FAIR_COL]);
        const probability = row[PROB_COL];
        const betId       = row[BETID_COL] || `row${i}`;

        // compute value %
        const valuePct = fairOdds > 0
          ? ((odds / fairOdds) * 100).toFixed(2) + '%'
          : 'N/A';

        // build embed
        const embed = new EmbedBuilder()
          .setColor('#2E7D32')
          .setTitle('💰 New Value Bet 💰')
          .setDescription(`**${sport}** — ${event}`)
          .addFields(
            { name: 'Bookie',      value: bookie,         inline: true },
            { name: 'Odds',        value: odds.toString(), inline: true },
            { name: 'Probability', value: probability,     inline: true },
            { name: 'Bet',         value: bet               },
            { name: 'Settles',     value: settleDate,      inline: true },
            { name: 'Value %',     value: valuePct,        inline: true }
          )
          .setTimestamp()
          .setFooter({ text: `Bet ID: ${betId}` });

        // add “Get/Edit Stake” button
        const rowAction = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`stakeModal_${betId}`)
            .setLabel('Get / Edit Stake')
            .setStyle(ButtonStyle.Primary)
        );

        const channel = await client.channels.fetch(CH_ID);
        await channel.send({ embeds: [embed], components: [rowAction] });

        await markRowSend(i, 'P');
      }
    }
  } catch (err) {
    console.error('❌ Error in processNewBets():', err);
  }
}

//
// —— Interaction handler: button click & modal submit ——
//
client.on('interactionCreate', async interaction => {
  // 1) Button click → show modal
  if (interaction.isButton() && interaction.customId.startsWith('stakeModal_')) {
    const betId = interaction.customId.split('_')[1];

    // fetch user settings
    const user = await userService.findByDiscordId(interaction.user.id);
    if (!user) {
      return interaction.reply({
        content: '❗ Please link your Discord in your account first.',
        flags: 64
      });
    }

    // lookup bet row & compute recommended stake
    const row     = await findSheetRowByBetId(betId);
    const odds    = parseFloat(row[ODDS_COL]);
    let   prob    = parseFloat(row[PROB_COL]);
    if (prob > 1) prob /= 100;

    let recommended;
    if (user.staking_mode === 'flat') {
      recommended = user.flat_amount;
    } else {
      const pct = Math.min(user.kelly_pct,100) / 100;
      recommended = Math.floor(((odds * prob - 1) / (odds - 1)) * user.bankroll * pct);
    }

    // fetch last override (if any)
    const previous = await userService.getUserBetStake(user.id, betId);
const defaultOverride =
  previous != null
    ? previous.toFixed(2)
    : '';

    // build & show modal
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

  // 2) Modal submit → persist & reply
  if (interaction.type === InteractionType.ModalSubmit &&
      interaction.customId.startsWith('stakeModalSubmit_')) {
    const betId   = interaction.customId.split('_')[1];
    const recStr  = interaction.fields.getTextInputValue('recommended');
    const overStr = interaction.fields.getTextInputValue('override');
    const finalStake = parseFloat(overStr) || parseFloat(recStr);

    // save override
    const user = await userService.findByDiscordId(interaction.user.id);
    await userService.saveUserBetStake(user.id, betId, finalStake);

    return interaction.reply({
      content: `💵 You’ve staked **£${finalStake.toFixed(2)}** on Bet ${betId}`,
      flags: 64
    });
  }
});

//
// —— Bot ready & cron schedule ——
//
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await processNewBets();
  cron.schedule('0 * * * * *', () => {
    console.log('⏱️ Checking for new bets…');
    processNewBets();
  });
});

// login & start express
client.login(process.env.DISCORD_TOKEN)
  .catch(err => console.error('❌ Discord login failed:', err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🔔 Webhook listener running on port ${PORT}`);
});