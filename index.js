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
const LOG_CHANNEL_NAME = "ping-logs";

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

// Dedicated message cache to guarantee ghost pings are never lost
const messageCache = new Map();

client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Helper: Fetch #ping-logs directly from Discord's API
async function getLogChannel(guild, fallbackChannel) {
  try {
    const channels = await guild.channels.fetch();
    const target = channels.find(
      (c) => c && c.name.toLowerCase() === LOG_CHANNEL_NAME.toLowerCase()
    );
    if (target) return target;
  } catch (err) {
    console.error("Error fetching channels:", err);
  }
  return fallbackChannel;
}

// Helper: Ban user safely and route confirmation to #ping-logs
async function enforceBan(guild, user, reason, triggerChannel) {
  const logChannel = await getLogChannel(guild, triggerChannel);

  try {
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      await guild.bans.create(user.id, { reason });
      if (logChannel) {
        await logChannel.send(`🔨 **Banned** <@${user.id}> | **Reason:** ${reason}`);
      }
      return;
    }

    if (!member.bannable) {
      if (logChannel) {
        await logChannel.send(`❌ Cannot ban <@${user.id}>: Member outranks the bot or holds Admin immunity.`);
      }
      return;
    }

    await member.ban({ reason });
    if (logChannel) {
      await logChannel.send(`🔨 **Banned** <@${user.id}> | **Reason:** ${reason}`);
    }
  } catch (err) {
    console.error(`Failed to ban user ${user.id}:`, err);
    if (logChannel) {
      await logChannel.send(`❌ Failed to ban <@${user.id}> due to missing permissions.`);
    }
  }
}

// --- Message Handler (Caching & Cooldown/Ban Logic) ---
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    // Cache incoming human messages for ghost ping detection (kept for 15 minutes)
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

      messageCache.set(message.id, {
        authorId: message.author.id,
        authorTag: message.author.tag,
        channelId: message.channel.id,
        content: message.content,
        mentions: pingList
      });

      // Clear from memory after 15 minutes
      setTimeout(() => messageCache.delete(message.id), 15 * 60 * 1000);
    }

    // --- Cooldown check for @homeys ---
    const hasRolePing = message.mentions.roles.some(
      (role) => role.name.toLowerCase() === ROLE_NAME.toLowerCase()
    );

    if (!hasRolePing) return;

    const now = Date.now();
    const timeSinceLastPing = now - lastPingTime;

    // Ping allowed: resets cooldown
    if (timeSinceLastPing >= COOLDOWN) {
      lastPingTime = now;
      console.log(`@${ROLE_NAME} ping allowed.`);
      return;
    }

    // Violation: ignore in ghost ping catcher and delete
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

      if (creator) {
        await enforceBan(
          message.guild,
          creator,
          `Webhook ping exploit: created webhook to ping @${ROLE_NAME} during cooldown`,
          message.channel
        );
      } else {
        const targetLog = await getLogChannel(message.guild, message.channel);
        await targetLog.send(`⚠️ Webhook ping blocked during cooldown. (Creator not found in recent audit logs).`);
      }
      return;
    }

    // Bot violation
    if (message.author.bot) {
      if (message.author.id === client.user.id) return;
      await enforceBan(
        message.guild,
        message.author,
        `Bot ping exploit: invoked to ping @${ROLE_NAME} during cooldown`,
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

// --- Ghost Ping Catcher (Routed directly to #ping-logs) ---
client.on("messageDelete", async (message) => {
  try {
    if (botDeletedMessageIds.has(message.id)) return;

    // Check our dedicated cache first
    let cached = messageCache.get(message.id);

    // Fallback to discord.js structure if present
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

    if (!cached || !cached.mentions || cached.mentions.length === 0) return;

    // Clean up cache entry
    messageCache.delete(message.id);

    const targetLogChannel = await getLogChannel(message.guild, message.channel);
    if (!targetLogChannel) return;

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
