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

    // --- Command: !backupserver (Full Server Architecture + Embeds) ---
    if (message.content.trim().toLowerCase().startsWith("!backupserver")) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("❌ Only administrators can run this command.");
      }

      const statusMsg = await message.reply("⏳ Creating complete server snapshot (roles, channels, permissions, embeds)...");

      try {
        const guild = message.guild;

        // 1. Snapshot Roles (excluding @everyone and managed bot roles)
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

        // 2. Snapshot Categories & Channels
        const channels = await guild.channels.fetch();
        const categories = channels.filter((c) => c && c.type === ChannelType.GuildCategory);
        const nonCategories = channels.filter((c) => c && c.type !== ChannelType.GuildCategory);

        const channelData = [];

        // Save categories first
        for (const [_, cat] of categories) {
          channelData.push({
            id: cat.id,
            name: cat.name,
            type: cat.type,
            rawPosition: cat.rawPosition,
            permissionOverwrites: cat.permissionOverwrites.cache.map((o) => ({
              id: o.id,
              type: o.type,
              allow: o.allow.bitfield.toString(),
              deny: o.deny.bitfield.toString()
            }))
          });
        }

        // Save normal channels
        for (const [_, ch] of nonCategories) {
          channelData.push({
            id: ch.id,
            name: ch.name,
            type: ch.type,
            topic: ch.topic || null,
            nsfw: ch.nsfw || false,
            rateLimitPerUser: ch.rateLimitPerUser || 0,
            parentName: ch.parent ? ch.parent.name : null,
            rawPosition: ch.rawPosition,
            permissionOverwrites: ch.permissionOverwrites ? ch.permissionOverwrites.cache.map((o) => ({
              id: o.id,
              type: o.type,
              allow: o.allow.bitfield.toString(),
              deny: o.deny.bitfield.toString()
            })) : []
          });
        }

        // 3. Snapshot Custom Rich Embeds
        const embedData = [];
        const textChannels = channels.filter(
          (c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
        );

        for (const [_, textCh] of textChannels) {
          try {
            const msgs = await textCh.messages.fetch({ limit: 100 });
            msgs.forEach((m) => {
              if (m.embeds && m.embeds.length > 0) {
                const richEmbeds = m.embeds.filter(
                  (e) => (e.data.type === "rich" || !e.data.type) && (e.title || e.description || e.fields?.length)
                );
                if (richEmbeds.length > 0) {
                  embedData.push({
                    channelName: textCh.name,
                    embeds: richEmbeds.map((e) => e.toJSON())
                  });
                }
              }
            });
          } catch (e) {
            console.error(`Skipped reading #${textCh.name} for embeds.`);
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
          content: `✅ **Full Server Snapshot Complete!**\n• Roles: **${roleData.length}**\n• Channels & Categories: **${channelData.length}**\n• Custom Embeds: **${embedData.length}**\n\nSave this file. Run \`!restoreserver\` with this file attached to restore everything.`,
          files: [attachment]
        });
      } catch (err) {
        console.error("Backup failed:", err);
        await statusMsg.edit("❌ Failed to compile server backup. Check bot permissions.");
      }
      return;
    }

    // --- Command: !restoreserver (Full Server Recovery) ---
    if (message.content.trim().toLowerCase().startsWith("!restoreserver")) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("❌ Only administrators can run this command.");
      }

      const file = message.attachments.find((att) => att.name.endsWith(".json"));
      if (!file) {
        return message.reply("❌ Please upload your `server-full-backup.json` file in the same message with `!restoreserver`.");
      }

      const statusMsg = await message.reply("⏳ Reading backup and reconstructing server structure...");

      try {
        const snapshot = await downloadJson(file.url);
        const guild = message.guild;

        let createdRoles = 0;
        let createdChannels = 0;
        let restoredEmbeds = 0;

        // 1. Restore Roles
        const existingRoles = await guild.roles.fetch();
        const roleMap = new Map(); // Old role ID / name -> New Role Object

        if (snapshot.roles && Array.isArray(snapshot.roles)) {
          for (const r of snapshot.roles) {
            try {
              let existing = existingRoles.find((ex) => ex.name.toLowerCase() === r.name.toLowerCase());
              if (!existing) {
                existing = await guild.roles.create({
                  name: r.name,
                  color: r.color,
                  hoist: r.hoist,
                  mentionable: r.mentionable,
                  permissions: BigInt(r.permissions),
                  reason: "Restored from server backup"
                });
                createdRoles++;
                await new Promise((res) => setTimeout(res, 350));
              }
              roleMap.set(r.id, existing);
              roleMap.set(r.name.toLowerCase(), existing);
            } catch (err) {
              console.error(`Failed restoring role ${r.name}:`, err.message);
            }
          }
        }

        // 2. Restore Categories First
        const existingChannels = await guild.channels.fetch();
        const categoryMap = new Map();

        const categories = (snapshot.channels || []).filter((c) => c.type === ChannelType.GuildCategory);
        for (const cat of categories) {
          try {
            let existingCat = existingChannels.find(
              (c) => c && c.type === ChannelType.GuildCategory && c.name.toLowerCase() === cat.name.toLowerCase()
            );
            if (!existingCat) {
              existingCat = await guild.channels.create({
                name: cat.name,
                type: ChannelType.GuildCategory,
                reason: "Restored category from backup"
              });
              createdChannels++;
              await new Promise((res) => setTimeout(res, 350));
            }
            categoryMap.set(cat.name.toLowerCase(), existingCat.id);
          } catch (err) {
            console.error(`Failed recreating category ${cat.name}:`, err.message);
          }
        }

        // 3. Restore Channels & Channel Settings
        const normalChannels = (snapshot.channels || []).filter((c) => c.type !== ChannelType.GuildCategory);
        const activeChannels = await guild.channels.fetch();

        for (const ch of normalChannels) {
          try {
            let existingCh = activeChannels.find(
              (c) => c && c.type === ch.type && c.name.toLowerCase() === ch.name.toLowerCase()
            );

            const parentId = ch.parentName ? categoryMap.get(ch.parentName.toLowerCase()) : null;

            if (!existingCh) {
              existingCh = await guild.channels.create({
                name: ch.name,
                type: ch.type,
                topic: ch.topic || undefined,
                nsfw: ch.nsfw,
                rateLimitPerUser: ch.rateLimitPerUser,
                parent: parentId || undefined,
                reason: "Restored channel from backup"
              });
              createdChannels++;
              await new Promise((res) => setTimeout(res, 350));
            } else if (parentId && existingCh.parentId !== parentId) {
              await existingCh.setParent(parentId).catch(() => {});
            }
          } catch (err) {
            console.error(`Failed recreating channel ${ch.name}:`, err.message);
          }
        }

        // 4. Restore Custom Embeds
        const refreshedChannels = await guild.channels.fetch();
        if (snapshot.embeds && Array.isArray(snapshot.embeds)) {
          for (const item of snapshot.embeds) {
            try {
              const targetChannel = refreshedChannels.find(
                (c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.toLowerCase() === item.channelName.toLowerCase()
              );
              if (!targetChannel) continue;

              for (const embedData of item.embeds) {
                const embed = new EmbedBuilder(embedData);
                await targetChannel.send({ embeds: [embed] });
                restoredEmbeds++;
                await new Promise((res) => setTimeout(res, 600));
              }
            } catch (err) {
              console.error(`Failed restoring embeds to #${item.channelName}:`, err.message);
            }
          }
        }

        await statusMsg.edit(
          `✅ **Server Rebuild Complete!**\n• Roles restored/verified: **${createdRoles}**\n• Channels & categories restored: **${createdChannels}**\n• Embeds re-posted: **${restoredEmbeds}**`
        );
      } catch (err) {
        console.error("Server restoration failed:", err);
        await statusMsg.edit("❌ Failed restoring server. Ensure the bot role is positioned at the top of the role list and has Administrator rights.");
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
