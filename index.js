const {
  Client,
  GatewayIntentBits,
  AuditLogEvent,
  EmbedBuilder
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const ROLE_NAME = "homeys";
const COOLDOWN = 60 * 60 * 1000; // 1 hour in ms

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

// Helper: Ban user safely
async function enforceBan(guild, user, reason, channel) {
  try {
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) {
      await guild.bans.create(user.id, { reason });
      if (channel) channel.send(`🔨 **Banned** <@${user.id}> for: ${reason}`);
      return;
    }

    if (!member.bannable) {
      if (channel) channel.send(`❌ Cannot ban <@${user.id}>: They outrank the bot or hold Admin immunity.`);
      return;
    }

    await member.ban({ reason });
    if (channel) channel.send(`🔨 **Banned** <@${user.id}> for: ${reason}`);
  } catch (err) {
    console.error(`Failed to ban user ${user.id}:`, err);
    if (channel) channel.send(`❌ Failed to ban <@${user.id}> due to missing permissions.`);
  }
}

// --- 1. Cooldown & Instant Ban Handler ---
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    // Detect if @homeys is mentioned (normal ping, raw tag, bot, or webhook)
    const hasRolePing = message.mentions.roles.some(
      (role) => role.name.toLowerCase() === ROLE_NAME.toLowerCase()
    );

    if (!hasRolePing) return;

    const now = Date.now();
    const timeSinceLastPing = now - lastPingTime;

    // Allowed ping: resets the cooldown
    if (timeSinceLastPing >= COOLDOWN) {
      lastPingTime = now;
      console.log(`@${ROLE_NAME} ping allowed.`);
      return;
    }

    // Cooldown violated: delete the offending ping instantly
    botDeletedMessageIds.add(message.id);
    setTimeout(() => botDeletedMessageIds.delete(message.id), 30000);
    await message.delete().catch(() => {});

    // Case A: Ping was executed via a Webhook
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
        message.channel.send(`⚠️ Webhook ping blocked during cooldown. (Creator not found in recent audit logs).`);
      }
      return;
    }

    // Case B: Ping was executed by another bot
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

// --- 2. Ghost Ping Catcher (Roles + Users/Members + Everyone/Here) ---
client.on("messageDelete", async (message) => {
  try {
    if (!message || !message.author || message.author.bot) return;
    if (botDeletedMessageIds.has(message.id)) return;

    const pingList = [];

    // Collect role mentions
    if (message.mentions.roles && message.mentions.roles.size > 0) {
      message.mentions.roles.forEach((r) => pingList.push(`@${r.name}`));
    }

    // Collect user/member mentions (excluding self-mentions)
    if (message.mentions.users && message.mentions.users.size > 0) {
      message.mentions.users
        .filter((u) => u.id !== message.author.id)
        .forEach((u) => pingList.push(`<@${u.id}>`));
    }

    // Collect @everyone / @here mentions
    if (message.mentions.everyone) {
      pingList.push("@everyone / @here");
    }

    // If any real pings were detected, expose the ghost ping
    if (pingList.length > 0) {
      const embed = new EmbedBuilder()
        .setColor(0xff3344)
        .setTitle("👻 Ghost Ping Detected")
        .setDescription(`**Author:** <@${message.author.id}> (${message.author.tag})\n**Channel:** <#${message.channel.id}>\n**Mentioned:** ${pingList.join(", ")}`)
        .addFields({
          name: "Original Message Content",
          value: message.content && message.content.length > 0 ? message.content : "*[No text / media only]*"
        })
        .setTimestamp();

      await message.channel.send({ embeds: [embed] });
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
