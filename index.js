const {
  Client,
  GatewayIntentBits,
  AuditLogEvent,
  EmbedBuilder
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const ROLE_NAME = "homeys";
const COOLDOWN = 60 * 60 * 1000; // 1 hour in ms

// --- Channel Configuration ---
const LOG_CHANNEL_NAME = "ping-logs";
const LOG_CHANNEL_ID = ""; 

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

let lastPingTime = 0;
const botDeletedMessageIds = new Set();

client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Helper: Resolve the ping-logs channel
function getLogChannel(guild, fallbackChannel) {
  if (LOG_CHANNEL_ID) {
    const ch = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (ch) return ch;
  }
  if (LOG_CHANNEL_NAME) {
    const ch = guild.channels.cache.find(
      (c) => c.name.toLowerCase() === LOG_CHANNEL_NAME.toLowerCase()
    );
    if (ch) return ch;
  }
  return fallbackChannel;
}

// Helper: Ban user safely and route log to #ping-logs
async function enforceBan(guild, user, reason, triggerChannel) {
  const logChannel = getLogChannel(guild, triggerChannel);

  try {
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      await guild.bans.create(user.id, { reason });
      if (logChannel) {
        logChannel.send(`🔨 **Banned** <@${user.id}> | **Reason:** ${reason}`);
      }
      return;
    }

    if (!member.bannable) {
      if (logChannel) {
        logChannel.send(`❌ Cannot ban <@${user.id}>: Member outranks the bot or holds Admin immunity.`);
      }
      return;
    }

    await member.ban({ reason });
    if (logChannel) {
      logChannel.send(`🔨 **Banned** <@${user.id}> | **Reason:** ${reason}`);
    }
  } catch (err) {
    console.error(`Failed to ban user ${user.id}:`, err);
    if (logChannel) {
      logChannel.send(`❌ Failed to ban <@${user.id}> due to missing permissions.`);
    }
  }
}

// --- 1. Cooldown & Instant Ban Handler ---
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    // Detect if @homeys is mentioned
    const hasRolePing = message.mentions.roles.some(
      (role) => role.name.toLowerCase() === ROLE_NAME.toLowerCase()
    );

    if (!hasRolePing) return;

    const now = Date.now();
    const timeSinceLastPing = now - lastPingTime;

    // Allowed ping
    if (timeSinceLastPing >= COOLDOWN) {
      lastPingTime = now;
      console.log(`@${ROLE_NAME} ping allowed.`);
      return;
    }

    // Cooldown violation: delete the offending ping instantly
    botDeletedMessageIds.add(message.id);
    setTimeout(() => botDeletedMessageIds.delete(message.id), 30000);
    await message.delete().catch(() => {});

    // Case A: Webhook ping
    if (message.webhookId) {
      await new Promise((r) => setTimeout(r, 1200));

      const auditLogs = await message.guild.fetchAuditLogs({
        limit: 5,
        type: AuditLogEvent.WebhookCreate
      }).catch(() => null);

      let creator = null;
      if (auditLogs) {
        const entry = auditLogs.entries.find((e) => e.target?.id === message.webhookId);
        if (entry && entry.executor) {
          creator = entry.executor;
        }
      }

      if (creator) {
        await enforceBan(
          message.guild,
          creator,
          `Webhook ping exploit: created webhook to ping @${ROLE_NAME} during cooldown`,
          message.channel
        );
      } else {
        const targetLog = getLogChannel(message.guild, message.channel);
        targetLog.send(`⚠️ Webhook ping blocked during cooldown. (Creator not found in recent audit logs).`);
      }
      return;
    }

    // Case B: Another bot ping
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

    // Case C: Standard Member ping violation -> Direct Ban
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

// --- 2. Ghost Ping Catcher (Sent directly to #ping-logs) ---
client.on("messageDelete", async (message) => {
  try {
    if (!message || !message.author || message.author.bot) return;
    if (botDeletedMessageIds.has(message.id)) return;

    const pingList = [];

    // Collect role mentions
    if (message.mentions.roles && message.mentions.roles.size > 0) {
      message.mentions.roles.forEach((r) => pingList.push(`@${r.name}`));
    }

    // Collect user/member mentions (skips self mentions)
    if (message.mentions.users && message.mentions.users.size > 0) {
      message.mentions.users
        .filter((u) => u.id !== message.author.id)
        .forEach((u) => pingList.push(`<@${u.id}>`));
    }

    // Collect @everyone / @here mentions
    if (message.mentions.everyone) {
      pingList.push("@everyone / @here");
    }

    if (pingList.length > 0) {
      const targetLogChannel = getLogChannel(message.guild, message.channel);

      const embed = new EmbedBuilder()
        .setColor(0xff3344)
        .setTitle("👻 Ghost Ping Detected")
        .setDescription(`**Author:** <@${message.author.id}> (${message.author.tag})\n**Origin Channel:** <#${message.channel.id}>\n**Mentioned:** ${pingList.join(", ")}`)
        .addFields({
          name: "Original Message Content",
          value: message.content && message.content.length > 0 ? message.content : "*[No text / media only]*"
        })
        .setTimestamp();

      await targetLogChannel.send({ embeds: [embed] });
    }
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
