const {
  Client,
  GatewayIntentBits,
  PermissionsBitField
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const ROLE_NAME = "homeys";
const COOLDOWN = 60 * 60 * 1000; // 1 hour in ms
const TIMEOUT_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

let lastPingTime = 0;
const warnCount = new Map();

client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild || message.author.bot) return;

    const hasRolePing = message.mentions.roles.some(
      (role) => role.name.toLowerCase() === ROLE_NAME.toLowerCase()
    );

    if (!hasRolePing) return;

    const now = Date.now();
    const timeSinceLastPing = now - lastPingTime;

    if (timeSinceLastPing >= COOLDOWN) {
      lastPingTime = now;
      warnCount.clear();
      console.log(`@${ROLE_NAME} ping allowed.`);
      return;
    }

    // Cooldown is active: delete offending message
    await message.delete().catch(() => {});

    const authorId = message.author.id;
    const currentWarns = (warnCount.get(authorId) || 0) + 1;
    warnCount.set(authorId, currentWarns);

    const remainingMinutes = Math.ceil((COOLDOWN - timeSinceLastPing) / (60 * 1000));

    if (currentWarns === 1) {
      const warnMsg = await message.channel.send(
        `⚠️ <@${authorId}>, the \`@${ROLE_NAME}\` role is on cooldown! Please wait **${remainingMinutes} more minute(s)** before pinging again.`
      );
      setTimeout(() => warnMsg.delete().catch(() => {}), 10000);
      return;
    }

    // 2nd violation or higher: attempt timeout, fallback to kick
    const member = message.member || await message.guild.members.fetch(authorId).catch(() => null);
    if (!member) return;

    try {
      await member.timeout(TIMEOUT_DURATION, "Cooldown violation: repeated @homeys ping");
      message.channel.send(
        `⚠️ <@${authorId}> has been timed out for 7 days for repeatedly pinging the role during cooldown.`
      );
    } catch (err) {
      try {
        await member.kick("Cooldown violation: repeated @homeys ping (Admin/Immune to timeout)");
        message.channel.send(
          `⚠️ <@${authorId}> could not be timed out (Admin/Immune), so they have been kicked from the server.`
        );
      } catch (kickErr) {
        message.channel.send(
          `❌ Could not moderate <@${authorId}>: Discord prevents bots from moderating the Server Owner or users with equal/higher roles.`
        );
      }
    }
  } catch (error) {
    console.error("Error processing message:", error);
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

client.login(TOKEN);
