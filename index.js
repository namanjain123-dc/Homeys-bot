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
const http = require("http");

// Tiny HTTP server to keep the bot alive 24/7 on free hosts (Render, Koyeb, etc.)
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Homeys Bot is online and running!");
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[HTTP] Keep-alive server listening on port ${PORT}`));

const TOKEN = process.env.DISCORD_TOKEN;
const ROLE_NAME = "homeys";
const COOLDOWN = 60 * 60 * 1000; // 1 hour in ms

// Dedicated Channel ID for #ping-logs
const LOG_CHANNEL_ID = "1554030875585421342";

// Bots to IGNORE during embed backups (OwO, Pokétwo, Mudae, Dank Memer, etc.)
const IGNORED_BOT_IDS = [
  "408785106942164992", // OwO Bot
  "854227910977716234", // OwO secondary
  "270904126974590976", // Dank Memer
  "664588538202423307", // Pokétwo
  "432610292342587392"  // Mudae
];

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

// Helper: Ban user or exploit safely
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

// --- 1. Message Create Handler ---
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    // ==========================================
    // COMMAND: !backupserver
    // ==========================================
    if (message.content.trim().toLowerCase().startsWith("!backupserver")) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("❌ Only administrators can run this command.");
      }

      const statusMsg = await message.reply("⏳ Creating clean server snapshot (roles, channels, filtered embeds)...");

      try {
        const guild = message.guild;

        // 1. Roles
        const roles = await guild.roles.fetch();
        const roleData = roles
          .filter((r) => r.id !== guild.id && !r.managed)
          .sort((a, b) => b.position - a.position)
          .map((r) => ({
            id: r.id,
            name: r.name,
            color: r.color,
            hoist: r.hoist,
            mentionable: r.mentionable,
            permissions: r.permissions.bitfield.toString(),
            position: r.position
          }));

        // 2. Categories & Channels
        const channels = await guild.channels.fetch();
        const categories = channels.filter((c) => c && c.type === ChannelType.GuildCategory);
        const nonCategories = channels.filter((c) => c && c.type !== ChannelType.GuildCategory);

        const channelData = [];

        for (const [_, cat] of categories) {
          channelData.push({
            id: cat.id,
            name: cat.name,
            type: cat.type,
            rawPosition: cat.rawPosition
          });
        }

        for (const [_, ch] of nonCategories) {
          channelData.push({
            id: ch.id,
            name: ch.name,
            type: ch.type,
            topic: ch.topic || null,
            nsfw: ch.nsfw || false,
            rateLimitPerUser: ch.rateLimitPerUser || 0,
            parentName: ch.parent ? ch.parent.name : null,
            rawPosition: ch.rawPosition
          });
        }

        // 3. Filtered Custom Embeds (Ignores OwO & Chat Spam)
        const embedData = [];
        let channelsToScan = [];

        if (message.mentions.channels.size > 0) {
          channelsToScan = Array.from(message.mentions.channels.values());
        } else {
          channelsToScan = Array.from(
            channels.filter((c) => {
              if (!c || (c.type !== ChannelType.GuildText && c.type !== ChannelType.GuildAnnouncement)) return false;
              const name = c.name.toLowerCase();
              return !name.includes("spam") && !name.includes("bot") && !name.includes("owo") && !name.includes("chat");
            }).values()
          );
        }

        for (const ch of channelsToScan) {
          try {
            const msgs = await ch.messages.fetch({ limit: 100 });
            msgs.forEach((m) => {
              if (IGNORED_BOT_IDS.includes(m.author.id)) return;
              if (m.author.username && m.author.username.toLowerCase().includes("owo")) return;

              if ((m.author.bot || m.webhookId) && m.embeds && m.embeds.length > 0) {
                const richEmbeds = m.embeds.filter(
                  (e) => (e.title || e.description || e.fields?.length) && !e.url?.includes("tenor.com")
                );
                if (richEmbeds.length > 0) {
                  embedData.push({
                    channelName: ch.name,
                    embeds: richEmbeds.map((e) => e.toJSON())
                  });
                }
              }
            });
          } catch (e) {
            console.error(`Skipped reading #${ch.name}`);
          }
        }

        const fullSnapshot = {
          guildName: guild.name,
          createdAt: new Date().toISOString(),
          roles: roleData,
          channels: channelData,
          embeds: embedData
        };

        const buffer = Buffer.from(JSON.stringify(fullSnapshot, null, 2), "utf-8");
        const attachment = new AttachmentBuilder(buffer, { name: "server-full-backup.json" });

        await statusMsg.edit({
          content: `✅ **Clean Server Snapshot Complete!**\n• Roles: **${roleData.length}**\n• Channels & Categories: **${channelData.length}**\n• Clean Server Embeds: **${embedData.length}**\n\nSave this file. Run \`!restoreserver\` (or \`!restoreonlyembeds\`) with this file attached.`,
          files: [attachment]
        });
      } catch (err) {
        console.error("Backup failed:", err);
        await statusMsg.edit("❌ Failed to compile server backup. Check bot permissions.");
      }
      return;
    }

    // ==========================================
    // COMMAND: !restoreonlyembeds (Fast & Direct)
    // ==========================================
    if (message.content.trim().toLowerCase().startsWith("!restoreonlyembeds")) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("❌ Only administrators can run this command.");
      }

      const file = message.attachments.find((att) => att.name.endsWith(".json"));
      if (!file) return message.reply("❌ Please attach your backup JSON file with `!restoreonlyembeds`.");

      const statusMsg = await message.reply("⏳ Fast-posting embeds directly to existing channels...");
      try {
        const response = await fetch(file.url);
        const snapshot = await response.json();
        const guildChannels = await message.guild.channels.fetch();
        let restored = 0;

        if (snapshot.embeds && Array.isArray(snapshot.embeds)) {
          for (const item of snapshot.embeds) {
            const ch = guildChannels.find(
              (c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.toLowerCase() === item.channelName.toLowerCase()
            );
            if (!ch) {
              console.log(`[SKIP] Channel #${item.channelName} not found.`);
              continue;
            }

            for (const data of item.embeds) {
              try {
                const embed = new EmbedBuilder(data);
                await ch.send({ embeds: [embed] });
                restored++;
                console.log(`[POSTED EMBED] #${ch.name}`);
                await new Promise((r) => setTimeout(r, 600));
              } catch (e) {
                console.error(`[EMBED FAIL] #${ch.name}:`, e.message);
              }
            }
          }
        }
        await statusMsg.edit(`✅ **Restore Complete!** Re-posted **${restored}** embeds.`);
      } catch (err) {
        await statusMsg.edit(`❌ Error: ${err.message}`);
      }
      return;
    }

    // ==========================================
    // COMMAND: !restoreserver (Full Rebuild)
    // ==========================================
    if (message.content.trim().toLowerCase().startsWith("!restoreserver")) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("❌ Only administrators can run this command.");
      }

      const file = message.attachments.find((att) => att.name.endsWith(".json"));
      if (!file) {
        return message.reply("❌ Please upload your `server-full-backup.json` file with `!restoreserver`.");
      }

      console.log(`[RESTORE INITIATED] Downloading file: ${file.url}`);
      const statusMsg = await message.reply("⏳ Reconstructing server structure (stall-proof mode)...");

      try {
        const response = await fetch(file.url);
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);
        const snapshot = await response.json();

        const guild = message.guild;
        let createdRoles = 0;
        let createdChannels = 0;
        let restoredEmbeds = 0;

        // Fetch once upfront to avoid rate limits
        const existingRoles = await guild.roles.fetch();
        const existingChannels = await guild.channels.fetch();

        // 1. Roles
        if (snapshot.roles && Array.isArray(snapshot.roles)) {
          for (const r of snapshot.roles) {
            try {
              const match = existingRoles.find((ex) => ex.name.toLowerCase() === r.name.toLowerCase());
              if (!match) {
                console.log(`[RESTORE] Creating role: ${r.name}`);
                await guild.roles.create({
                  name: r.name,
                  color: r.color,
                  hoist: r.hoist,
                  mentionable: r.mentionable,
                  permissions: BigInt(r.permissions),
                  reason: "Restored from backup"
                });
                createdRoles++;
                await new Promise((res) => setTimeout(res, 400));
              }
            } catch (err) {
              console.error(`[ROLE ERROR] ${r.name}:`, err.message);
            }
          }
        }

        // 2. Categories
        const categoryMap = new Map();
        const categories = (snapshot.channels || []).filter((c) => c.type === ChannelType.GuildCategory);
        for (const cat of categories) {
          try {
            let catObj = existingChannels.find(
              (c) => c && c.type === ChannelType.GuildCategory && c.name.toLowerCase() === cat.name.toLowerCase()
            );
            if (!catObj) {
              console.log(`[RESTORE] Creating category: ${cat.name}`);
              catObj = await guild.channels.create({
                name: cat.name,
                type: ChannelType.GuildCategory,
                reason: "Restored from backup"
              });
              createdChannels++;
              await new Promise((res) => setTimeout(res, 400));
            }
            categoryMap.set(cat.name.toLowerCase(), catObj.id);
          } catch (err) {
            console.error(`[CAT ERROR] ${cat.name}:`, err.message);
          }
        }

        // 3. Channels
        const normalChannels = (snapshot.channels || []).filter((c) => c.type !== ChannelType.GuildCategory);
        for (const ch of normalChannels) {
          try {
            let chObj = existingChannels.find(
              (c) => c && c.type === ch.type && c.name.toLowerCase() === ch.name.toLowerCase()
            );
            const parentId = ch.parentName ? categoryMap.get(ch.parentName.toLowerCase()) : null;

            if (!chObj) {
              console.log(`[RESTORE] Creating channel: #${ch.name}`);
              await guild.channels.create({
                name: ch.name,
                type: ch.type,
                topic: ch.topic || undefined,
                nsfw: ch.nsfw,
                rateLimitPerUser: ch.rateLimitPerUser,
                parent: parentId || undefined,
                reason: "Restored from backup"
              });
              createdChannels++;
              await new Promise((res) => setTimeout(res, 400));
            }
          } catch (err) {
            console.error(`[CH ERROR] #${ch.name}:`, err.message);
          }
        }

        // 4. Custom Embeds
        const updatedChannels = await guild.channels.fetch();
        if (snapshot.embeds && Array.isArray(snapshot.embeds)) {
          for (const item of snapshot.embeds) {
            try {
              const targetChannel = updatedChannels.find(
                (c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.toLowerCase() === item.channelName.toLowerCase()
              );
              if (!targetChannel) continue;

              for (const embedData of item.embeds) {
                const embed = new EmbedBuilder(embedData);
                await targetChannel.send({ embeds: [embed] });
                restoredEmbeds++;
                console.log(`[RESTORE EMBED] Posted to #${item.channelName}`);
                await new Promise((res) => setTimeout(res, 600));
              }
            } catch (err) {
              console.error(`[EMBED ERROR] #${item.channelName}:`, err.message);
            }
          }
        }

        await statusMsg.edit(
          `✅ **Server Rebuild Complete!**\n• Roles added: **${createdRoles}**\n• Channels added: **${createdChannels}**\n• Embeds re-posted: **${restoredEmbeds}**`
        );
      } catch (err) {
        console.error("[RESTORE CRITICAL ERROR]:", err);
        await statusMsg.edit(`❌ Critical error: ${err.message}`);
      }
      return;
    }

    // ==========================================
    // GHOST PING CACHING
    // ==========================================
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
        setTimeout(() => messageCache.delete(message.id), 15 * 60 * 1000);
      }
    }

    // ==========================================
    // @homeys 1-HOUR COOLDOWN & ANTI-PING BAN
    // ==========================================
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
    if (botDeletedMessageIds.has(message.id)) return;

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

    if (!cached || !cached.mentions || cached.mentions.length === 0) return;

    messageCache.delete(message.id);

    const targetLogChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
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
