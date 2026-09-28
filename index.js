const {
  Client,
  GatewayIntentBits,
  Partials,
  AuditLogEvent,
  EmbedBuilder
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const ROLE_NAME = "homeys";
const COOLDOWN = 60 * 60 * 1000; // 1 hour in ms

// Dedicated Channel ID for #ping-logs
const LOG_CHANNEL_ID = "1554030875585421342";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Channel]
});

let lastPingTime = 0;
const botDeletedMessageIds = new Set();
const messageCache = new Map();

client.on("ready", async () => {
  console.log(`[BOT READY] Logged in as ${client.user.tag}`);

  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID);
    console.log(`[CHANNEL OK] Connected to target log channel: #${ch.name}`);
  } catch (e) {
    console.error(`[CHANNEL ERROR] Could not access channel ID ${LOG_CHANNEL_ID}:`, e.message);
  }
});

// Helper: Ban user safely
async function enforceBan(guild, user, reason, triggerChannel) {
  let logChannel = null;
  try {
    logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  } catch (e) {}
  if (!logChannel) logChannel = triggerChannel;

  try {
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      await guild.bans.create(user.id, { reason });
      if (logChannel) logChannel.send(`🔨 **Banned** <@${user.id}> | **Reason:** ${reason}`);
      return;
    }

    if (!member.bannable) {
      if (logChannel) logChannel.send(`❌ Cannot ban <@${user.id}>: Member outranks bot or holds Admin immunity.`);
      return;
    }

    await member.ban({ reason });
    if (logChannel) logChannel.send(`🔨 **Banned** <@${user.id}> | **Reason:** ${reason}`);
  } catch (err) {
    console.error(`Failed to ban user ${user.id}:`, err);
    if (logChannel) logChannel.send(`❌ Failed to ban <@${user.id}> due to missing permissions.`);
  }
}

// --- 1. Message Create (Cache + Cooldown/Ban) ---
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    // Cache incoming human messages for ghost pings
    if (!message.author.bot) {
      const pingList = [];

      if (message.mentions.roles.size > 0) {
        message.mentions.roles.forEach((r) => pingList.push(`@${r.name}`));
      }
      if (message.mentions.users.size > 0) {
        message.mentions.users
          .filter((u) => u.id !== message.author.id)
          .forEach((u) => pingList.push(`<@${u.id}>`));
      }
      if (message.mentions.everyone) {
        pingList.push("@everyone / @here");
      }

      if (pingList.length > 0) {
        messageCache.set(message.id, {
          authorId: message.author.id,
          authorTag: message.author.tag,
          channelId: message.channel.id,
          content: message.content,
          mentions: pingList
        });
        console.log(`[CACHED PING] Message ${message.id} by ${message.author.tag} contains: ${pingList.join(", ")}`);
        setTimeout(() => messageCache.delete(message.id), 15 * 60 * 1000);
      }
    }

    // Cooldown check for @homeys
    const hasRolePing = message.mentions.roles.some(
      (role) => role.name.toLowerCase() === ROLE_NAME.toLowerCase()
    );

    if (!hasRolePing) return;

    const now = Date.now();
    const timeSinceLastPing = now - lastPingTime;

    if (timeSinceLastPing >= COOLDOWN) {
      lastPingTime = now;
      console.log(`@${ROLE_NAME} ping allowed.`);
      return;
    }

    botDeletedMessageIds.add(message.id);
    messageCache.delete(message.id);
    setTimeout(() => botDeletedMessageIds.delete(message.id), 30000);
    await message.delete().catch(() => {});

    // Webhook violation
    if (message.webhookId) {
      await new Promise((r) => setTimeout(r, 1200));
      const auditLogs = await message.guild.fetchAuditLogs({
        limit: 5,
        type: AuditLogEvent.WebhookCreate
      }).catch(() => null);

      let creator = null;
      if (auditLogs) {
        const entry = auditLogs.entries.find((e) => e.target?.id === message.webhookId);
        if (entry && entry.executor) creator = entry.executor;
      }

      await enforceBan(
        message.guild,
        creator || { id: "Unknown" },
        `Webhook ping exploit for @${ROLE_NAME} during cooldown`,
        message.channel
      );
      return;
    }

    // Bot violation
    if (message.author.bot) {
      if (message.author.id === client.user.id) return;
      await enforceBan(
        message.guild,
        message.author,
        `Bot ping exploit for @${ROLE_NAME} during cooldown`,
        message.channel
      );
      return;
    }

    // Member violation -> Direct Ban
    await enforceBan(
      message.guild,
      message.author,
      `Pinging @${ROLE_NAME} during active cooldown`,
      message.channel
    );
  } catch (error) {
    console.error("Error processing messageCreate:", error);
  }
});

// --- 2. Ghost Ping Catcher ---
client.on("messageDelete", async (message) => {
  try {
    console.log(`[DELETE EVENT] Message deleted: ${message.id}`);

    if (botDeletedMessageIds.has(message.id)) {
      console.log(`[DELETE IGNORED] Message was deleted by bot moderation.`);
      return;
    }

    let cached = messageCache.get(message.id);

    // Fallback if cached via discord.js
    if (!cached && message && message.author && !message.author.bot) {
      const pingList = [];
      if (message.mentions.roles?.size > 0) message.mentions.roles.forEach((r) => pingList.push(`@${r.name}`));
      if (message.mentions.users?.size > 0) {
        message.mentions.users.filter((u) => u.id !== message.author.id).forEach((u) => pingList.push(`<@${u.id}>`));
      }
      if (message.mentions.everyone) pingList.push("@everyone / @here");

      if (pingList.length > 0) {
        cached = {
          authorId: message.author.id,
          authorTag: message.author.tag,
          channelId: message.channel.id,
          content: message.content,
          mentions: pingList
        };
      }
    }

    if (!cached || !cached.mentions || cached.mentions.length === 0) {
      console.log(`[DELETE IGNORED] Deleted message had no tracked pings or wasn't cached.`);
      return;
    }

    messageCache.delete(message.id);

    const targetLogChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch((e) => {
      console.error(`[FETCH FAIL] Could not fetch log channel:`, e.message);
      return null;
    });

    if (!targetLogChannel) {
      console.error(`[ERROR] No valid log channel found to send embed!`);
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0xff3344)
      .setTitle("👻 Ghost Ping Detected")
      .setDescription(
        `**Author:** <@${cached.authorId}> (${cached.authorTag})\n` +
        `**Origin Channel:** <#${cached.channelId}>\n` +
        `**Mentioned:** ${cached.mentions.join(", ")}`
      )
      .addFields({
        name: "Original Message Content",
        value: cached.content && cached.content.trim().length > 0 ? cached.content : "*[No text / media only]*"
      })
      .setTimestamp();

    await targetLogChannel.send({ embeds: [embed] });
    console.log(`[SUCCESS] Ghost ping embed posted in #${targetLogChannel.name}`);
  } catch (error) {
    console.error("Error handling messageDelete:", error);
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

client.login(TOKEN);
