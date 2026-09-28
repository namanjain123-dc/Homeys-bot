const {
  Client,
  GatewayIntentBits,
  Partials,
  AuditLogEvent,
  EmbedBuilder,
  AttachmentBuilder,
  PermissionsBitField,
  ChannelType
} = require("discord.js");
const https = require("https");

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

// Helper: Download JSON attachment into memory
function downloadJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on("error", (err) => reject(err));
  });
}

// --- 1. Message Create Handler ---
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    // --- Command: !backupembeds (Admin Only) ---
    // Usage: `!backupembeds` OR `!backupembeds #rules #announcements`
    if (message.content.trim().toLowerCase().startsWith("!backupembeds")) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("❌ Only administrators can run this command.");
      }

      const statusMsg = await message.reply("⏳ Scanning for custom rich embeds...");
      const backupData = [];

      try {
        let channelsToScan = [];

        // If specific channels were mentioned, scan only those
        if (message.mentions.channels.size > 0) {
          channelsToScan = Array.from(message.mentions.channels.values());
        } else {
          // Otherwise, scan all text/announcement channels
          const channels = await message.guild.channels.fetch();
          channelsToScan = Array.from(
            channels.filter(
              (c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
            ).values()
          );
        }

        for (const channel of channelsToScan) {
          try {
            const messages = await channel.messages.fetch({ limit: 100 });
            messages.forEach((msg) => {
              if (msg.embeds && msg.embeds.length > 0) {
                // Filter out YouTube/Twitter/GIF link previews; only keep genuine bot/webhook embeds
                const realCustomEmbeds = msg.embeds.filter(
                  (e) => (e.data.type === "rich" || !e.data.type) && (e.title || e.description || e.fields?.length)
                );

                if (realCustomEmbeds.length > 0) {
                  backupData.push({
                    channelId: channel.id,
                    channelName: channel.name,
                    channelType: channel.type,
                    messageId: msg.id,
                    embeds: realCustomEmbeds.map((e) => e.toJSON())
                  });
                }
              }
            });
          } catch (err) {
            console.error(`Skipping channel #${channel.name}:`, err.message);
          }
        }

        if (backupData.length === 0) {
          return await statusMsg.edit("❌ Found 0 custom rich embeds in the selected channels.");
        }

        const buffer = Buffer.from(JSON.stringify(backupData, null, 2), "utf-8");
        const attachment = new AttachmentBuilder(buffer, { name: "embeds-backup.json" });

        await statusMsg.edit({
          content: `✅ Successfully backed up **${backupData.length}** custom embeds from ${channelsToScan.length} channel(s)! (Link previews & GIFs excluded).`,
          files: [attachment]
        });
      } catch (err) {
        console.error("Backup failed:", err);
        await statusMsg.edit("❌ Failed to complete backup. Check bot permissions.");
      }
      return;
    }

    // --- Command: !restoreembeds (Admin Only) ---
    // Usage: Upload embeds-backup.json and type !restoreembeds
    if (message.content.trim().toLowerCase().startsWith("!restoreembeds")) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("❌ Only administrators can run this command.");
      }

      const file = message.attachments.find((att) => att.name.endsWith(".json"));
      if (!file) {
        return message.reply("❌ Please upload your `embeds-backup.json` file in the same message with `!restoreembeds`.");
      }

      const statusMsg = await message.reply("⏳ Reading backup file and restoring embeds...");

      try {
        const backupData = await downloadJson(file.url);
        let restoredCount = 0;
        let createdChannelCount = 0;

        let currentChannels = await message.guild.channels.fetch();

        for (const item of backupData) {
          try {
            // 1. Try to find the channel by original ID
            let targetChannel = currentChannels.get(item.channelId);

            // 2. If ID changed or deleted, find by name
            if (!targetChannel) {
              targetChannel = currentChannels.find(
                (c) => c && c.name.toLowerCase() === item.channelName.toLowerCase()
              );
            }

            // 3. If missing completely, automatically recreate it
            if (!targetChannel) {
              targetChannel = await message.guild.channels.create({
                name: item.channelName,
                type: item.channelType || ChannelType.GuildText,
                reason: "Auto-recreated during embed restoration"
              });
              createdChannelCount++;
              currentChannels = await message.guild.channels.fetch();
            }

            // Re-post each embed
            for (const embedData of item.embeds) {
              const embed = new EmbedBuilder(embedData);
              await targetChannel.send({ embeds: [embed] });
              restoredCount++;
              await new Promise((r) => setTimeout(r, 600)); // Rate limit safety
            }
          } catch (err) {
            console.error(`Failed restoring embeds for #${item.channelName}:`, err);
          }
        }

        await statusMsg.edit(
          `✅ Restore complete!\n• Re-posted **${restoredCount}** embeds.\n• Auto-recreated **${createdChannelCount}** missing channels.`
        );
      } catch (err) {
        console.error("Restore failed:", err);
        await statusMsg.edit("❌ Failed to restore embeds. Make sure the uploaded file is a valid JSON backup.");
      }
      return;
    }

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
