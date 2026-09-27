const { Client, GatewayIntentBits } = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Prevent unhandled errors from crashing the bot
process.on("unhandledRejection", (error) => console.error("Unhandled Rejection:", error));
process.on("uncaughtException", (error) => console.error("Uncaught Exception:", error));

const COOLDOWN = 60 * 60 * 1000; // 60 minutes
const TIMEOUT_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

// serverId -> { lastPing: timestamp, violations: Map(userId -> count) }
const serverData = new Map();

client.on("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild || message.author.bot) return;

    // Match role 'homeys'
    const role = message.guild.roles.cache.find(
      (r) => r.name.toLowerCase() === "homeys"
    );
    if (!role) return;

    // Check if the message mentions the role
    if (!message.mentions.roles.has(role.id)) return;

    const guildId = message.guild.id;
    const userId = message.author.id;
    const now = Date.now();

    if (!serverData.has(guildId)) {
      serverData.set(guildId, {
        lastPing: 0,
        violations: new Map()
      });
    }

    const data = serverData.get(guildId);

    // First ping / cooldown expired -> allow ping
    if (now - data.lastPing >= COOLDOWN) {
      data.lastPing = now;
      data.violations.clear();
      console.log(`@${role.name} ping allowed.`);
      return;
    }

    // Pinged within cooldown -> delete message
    try {
      await message.delete();
    } catch (err) {
      console.error("Could not delete message:", err.message);
    }

    // Track user violations
    const userViolations = (data.violations.get(userId) || 0) + 1;
    data.violations.set(userId, userViolations);

    // Fetch full member object
    const member = await message.guild.members.fetch(userId).catch(() => null);

    if (userViolations === 1) {
      // 1st violation: warning
      const remainingMs = COOLDOWN - (now - data.lastPing);
      const minutes = Math.ceil(remainingMs / 60000);

      const warn = await message.channel.send(
        `⚠️ <@${userId}>, @${role.name} is on cooldown! You can ping it again in **${minutes}m**. Another attempt will result in a 7-day timeout.`
      ).catch(() => null);

      if (warn) {
        setTimeout(() => warn.delete().catch(() => null), 6000);
      }
    } else {
      // 2nd+ violation: timeout or kick
      if (member && member.moderatable) {
        await member.timeout(TIMEOUT_DURATION, "Repeated ping during role cooldown").catch(console.error);
        const banMsg = await message.channel.send(
          `⛔ <@${userId}> has been timed out for 7 days for pinging @${role.name} repeatedly.`
        ).catch(() => null);
        if (banMsg) setTimeout(() => banMsg.delete().catch(() => null), 8000);
      } else {
        const warn = await message.channel.send(
          `⚠️ <@${userId}> cannot be timed out (they outrank the bot or own the server).`
        ).catch(() => null);
        if (warn) setTimeout(() => warn.delete().catch(() => null), 6000);
      }
    }
  } catch (err) {
    console.error("Message handler error:", err);
  }
});

client.login(process.env.DISCORD_TOKEN);
