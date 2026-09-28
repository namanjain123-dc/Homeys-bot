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

// Custom mention auto-reply storage: Map<userId, customMessage>
const userCustomReplies = new Map();
// Spam cooldown map for mention replies: Map<"userId-channelId", timestamp>
const replyCooldowns = new Map();

client.on("clientReady", async () => {
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

// Helper: Promise with timeout to prevent gateway hangs
function withTimeout(promise, ms = 4000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms))
  ]);
}

// --- 1. Message Create Handler ---
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    // ==========================================
    // COMMAND: ,setafk <message>
    // ==========================================
    if (message.content.trim().toLowerCase().startsWith(",setafk")) {
      const text = message.content.slice(7).trim();
      if (!text) {
        return message.reply("❌ Please provide the message you want the bot to reply with.\n*Example:* `,setafk The fuck did you ping me for?`");
      }
      userCustomReplies.set(message.author.id, text);
      const reply = await message.reply("✅ Your custom mention message has been updated!");
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      return;
    }

    // ==========================================
    // COMMAND: ,clearafk
    // ==========================================
    if (message.content.trim().toLowerCase() === ",clearafk") {
      userCustomReplies.delete(message.author.id);
      const reply = await message.reply("🗑️ Your custom mention auto-response has been cleared.");
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      return;
    }

    // ==========================================
    // COMMAND: ,showafk
    // ==========================================
    if (message.content.trim().toLowerCase() === ",showafk") {
      const current = userCustomReplies.get(message.author.id);
      if (!current) {
        return message.reply("ℹ️ You do not have an active custom mention message set. Use `,setafk <message>` to set one.");
      }
      return message.reply(`📌 **Your current mention message:**\n> ${current}`);
    }

    // ==========================================
    // COMMAND: ,purge <amount>
    // ==========================================
    if (message.content.trim().toLowerCase().startsWith(",purge")) {
      if (
        !message.member.permissions.has(PermissionsBitField.Flags.ManageMessages) &&
        !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
      ) {
        return message.reply("❌ You need the **Manage Messages** permission to use `,purge`.");
      }

      const args = message.content.trim().split(/\s+/);
      const count = parseInt(args[1], 10);

      if (isNaN(count) || count < 1 || count > 100) {
        return message.reply("❌ Please provide a valid number between **1** and **100**.\n*Example:* `,purge 20`");
      }

      try {
        await message.delete().catch(() => {});
        const fetched = await message.channel.messages.fetch({ limit: count });

        fetched.forEach((msg) => {
          botDeletedMessageIds.add(msg.id);
          messageCache.delete(msg.id);
          setTimeout(() => botDeletedMessageIds.delete(msg.id), 30000);
        });

        const deleted = await message.channel.bulkDelete(fetched, true);
        const confirmMsg = await message.channel.send(`🧹 Successfully purged **${deleted.size}** messages.`);
        setTimeout(() => confirmMsg.delete().catch(() => {}), 4000);
      } catch (err) {
        console.error("Purge Error:", err);
        message.channel.send("❌ Could not purge messages (Discord cannot bulk delete messages older than 14 days).")
          .then((m) => setTimeout(() => m.delete().catch(() => {}), 5000));
      }
      return;
    }

    // ==========================================
    // COMMAND: ,backupserver / ,backupembeds
    // ==========================================
    if (
      message.content.trim().toLowerCase().startsWith(",backupserver") ||
      message.content.trim().toLowerCase().startsWith(",backupembeds")
    ) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("❌ Only administrators can run this command.");
      }

      const statusMsg = await message.reply("⏳ Creating clean server snapshot with permissions...");

      try {
        const guild = message.guild;

        const roles = await guild.roles.fetch();
        const roleData = roles
          .filter((r) => !r.managed)
          .sort((a, b) => b.position - a.position)
          .map((r) => ({
            id: r.id,
            name: r.name,
            color: r.color,
            hoist: r.hoist,
            mentionable: r.mentionable,
            permissions: r.permissions.bitfield.toString(),
            position: r.position,
            isEveryone: r.id === guild.id
          }));

        const channels = await guild.channels.fetch();
        const categories = channels.filter((c) => c && c.type === ChannelType.GuildCategory);
        const nonCategories = channels.filter((c) => c && c.type !== ChannelType.GuildCategory);

        const channelData = [];

        function extractOverwrites(ch) {
          const overwrites = [];
          ch.permissionOverwrites.cache.forEach((ov) => {
            const targetRole = roles.get(ov.id);
            overwrites.push({
              name: targetRole ? targetRole.name : null,
              isEveryone: ov.id === guild.id,
              type: ov.type,
              allow: ov.allow.bitfield.toString(),
              deny: ov.deny.bitfield.toString()
            });
          });
          return overwrites;
        }

        for (const [_, cat] of categories) {
          channelData.push({
            id: cat.id,
            name: cat.name,
            type: cat.type,
            rawPosition: cat.rawPosition,
            permissionOverwrites: extractOverwrites(cat)
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
            rawPosition: ch.rawPosition,
            permissionOverwrites: extractOverwrites(ch)
          });
        }

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
          content: `✅ **Server Snapshot Complete!**\n• Roles & Permissions: **${roleData.length}**\n• Channels & Overwrites: **${channelData.length}**\n• Embeds: **${embedData.length}**`,
          files: [attachment]
        });
      } catch (err) {
        console.error("Backup failed:", err);
        await statusMsg.edit("❌ Failed to compile server backup.");
      }
      return;
    }

    // ==========================================
    // COMMAND: ,restoreonlyembeds (Embeds ONLY)
    // ==========================================
    if (message.content.trim().toLowerCase().startsWith(",restoreonlyembeds")) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("❌ Only administrators can run this command.");
      }

      const file = message.attachments.find((att) => att.name.endsWith(".json"));
      if (!file) return message.reply("❌ Please attach your backup JSON file with `,restoreonlyembeds`.");

      const statusMsg = await message.reply("⏳ Fast-posting embeds directly into matching channels...");
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
              console.log(`[SKIP EMBED] Channel #${item.channelName} not found.`);
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
    // COMMAND: ,restoreserver (Default: SKIPS EMBEDS)
    // Add "--embeds" to restore embeds as well
    // ==========================================
    if (message.content.trim().toLowerCase().startsWith(",restoreserver")) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("❌ Only administrators can run this command.");
      }

      const file = message.attachments.find((att) => att.name.endsWith(".json"));
      if (!file) {
        return message.reply("❌ Please upload your `server-full-backup.json` file with `,restoreserver`.");
      }

      const commandText = message.content.toLowerCase();
      const includeEmbeds = commandText.includes("--embeds") || commandText.includes("with-embeds");

      console.log(`[RESTORE INITIATED] Downloading file: ${file.url} | Include Embeds: ${includeEmbeds}`);
      const statusMsg = await message.reply(
        includeEmbeds
          ? "⏳ Syncing server structure, permissions, and embeds..."
          : "⏳ Syncing server structure and updating permissions (embeds skipped)..."
      );

      try {
        const response = await fetch(file.url);
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);
        const snapshot = await response.json();

        const guild = message.guild;
        let createdRoles = 0;
        let updatedRoles = 0;
        let createdChannels = 0;
        let updatedChannels = 0;
        let restoredEmbeds = 0;

        let existingRoles = await guild.roles.fetch();
        let existingChannels = await guild.channels.fetch();

        // 1. Roles
        if (snapshot.roles && Array.isArray(snapshot.roles)) {
          for (const r of snapshot.roles) {
            try {
              let match = r.isEveryone
                ? guild.roles.everyone
                : existingRoles.find((ex) => ex.name.toLowerCase() === r.name.toLowerCase());

              if (!match && !r.isEveryone) {
                console.log(`[RESTORE ROLE] Creating role: ${r.name}`);
                match = await withTimeout(
                  guild.roles.create({
                    name: r.name,
                    color: r.color,
                    hoist: r.hoist,
                    mentionable: r.mentionable,
                    permissions: BigInt(r.permissions),
                    reason: "Restored from backup"
                  }),
                  3500
                );
                createdRoles++;
                await new Promise((res) => setTimeout(res, 350));
              } else if (match) {
                if (guild.members.me.roles.highest.position > match.position) {
                  await withTimeout(
                    match.setPermissions(BigInt(r.permissions), "Synced permissions from backup"),
                    3500
                  ).catch(() => {});
                  updatedRoles++;
                }
              }
            } catch (err) {
              console.error(`[ROLE ERROR] ${r.name}:`, err.message);
            }
          }
        }

        existingRoles = await guild.roles.fetch();

        function buildOverwrites(rawOverwrites) {
          if (!rawOverwrites || !Array.isArray(rawOverwrites)) return [];
          const overwrites = [];
          for (const ov of rawOverwrites) {
            let targetId = null;
            if (ov.isEveryone) {
              targetId = guild.roles.everyone.id;
            } else if (ov.name) {
              const matchedRole = existingRoles.find((r) => r.name.toLowerCase() === ov.name.toLowerCase());
              if (matchedRole) targetId = matchedRole.id;
            }

            if (targetId) {
              overwrites.push({
                id: targetId,
                type: ov.type,
                allow: BigInt(ov.allow || 0),
                deny: BigInt(ov.deny || 0)
              });
            }
          }
          return overwrites;
        }

        // 2. Categories
        const categoryMap = new Map();
        const categories = (snapshot.channels || []).filter((c) => c.type === ChannelType.GuildCategory);
        for (const cat of categories) {
          try {
            let catObj = existingChannels.find(
              (c) => c && c.type === ChannelType.GuildCategory && c.name.toLowerCase() === cat.name.toLowerCase()
            );
            const overwrites = buildOverwrites(cat.permissionOverwrites);

            if (!catObj) {
              console.log(`[RESTORE CATEGORY] Creating: ${cat.name}`);
              catObj = await withTimeout(
                guild.channels.create({
                  name: cat.name,
                  type: ChannelType.GuildCategory,
                  permissionOverwrites: overwrites.length > 0 ? overwrites : undefined,
                  reason: "Restored from backup"
                }),
                3500
              );
              createdChannels++;
              await new Promise((res) => setTimeout(res, 350));
            } else {
              if (overwrites.length > 0) {
                await withTimeout(catObj.permissionOverwrites.set(overwrites), 3500).catch(() => {});
                updatedChannels++;
              }
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
              (c) => c && c.name.toLowerCase() === ch.name.toLowerCase()
            );
            const parentId = ch.parentName ? categoryMap.get(ch.parentName.toLowerCase()) : null;
            const overwrites = buildOverwrites(ch.permissionOverwrites);

            if (!chObj) {
              const safeType = ch.type === ChannelType.GuildAnnouncement ? ChannelType.GuildText : ch.type;
              console.log(`[RESTORE CHANNEL] Creating #${ch.name} (Type: ${safeType})`);

              await withTimeout(
                guild.channels.create({
                  name: ch.name,
                  type: safeType,
                  topic: ch.topic || undefined,
                  nsfw: ch.nsfw,
                  rateLimitPerUser: ch.rateLimitPerUser,
                  parent: parentId || undefined,
                  permissionOverwrites: overwrites.length > 0 ? overwrites : undefined,
                  reason: "Restored from backup"
                }),
                3500
              );

              createdChannels++;
              await new Promise((res) => setTimeout(res, 350));
            } else {
              if (parentId && chObj.parentId !== parentId) {
                await chObj.setParent(parentId).catch(() => {});
              }
              if (overwrites.length > 0) {
                await withTimeout(chObj.permissionOverwrites.set(overwrites), 3500).catch(() => {});
                updatedChannels++;
              }
            }
          } catch (err) {
            console.error(`[CH ERROR SKIPPED] #${ch.name}:`, err.message);
          }
        }

        // 4. Embeds
        if (includeEmbeds && snapshot.embeds && Array.isArray(snapshot.embeds)) {
          const updatedChannelsList = await guild.channels.fetch();
          for (const item of snapshot.embeds) {
            try {
              const targetChannel = updatedChannelsList.find(
                (c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) && c.name.toLowerCase() === item.channelName.toLowerCase()
              );
              if (!targetChannel) continue;

              for (const embedData of item.embeds) {
                const embed = new EmbedBuilder(embedData);
                await withTimeout(targetChannel.send({ embeds: [embed] }), 3500);
                restoredEmbeds++;
                console.log(`[RESTORE EMBED] Posted to #${item.channelName}`);
                await new Promise((res) => setTimeout(res, 500));
              }
            } catch (err) {
              console.error(`[EMBED ERROR] #${item.channelName}:`, err.message);
            }
          }
        }

        await statusMsg.edit(
          `✅ **Server Rebuild & Permissions Synced!**\n• Roles: **${createdRoles}** added, **${updatedRoles}** permissions synced\n• Channels: **${createdChannels}** added, **${updatedChannels}** permissions synced\n• Embeds: **${restoredEmbeds}**${!includeEmbeds ? " *(Embed recovery skipped)*" : ""}`
        );
      } catch (err) {
        console.error("[RESTORE CRITICAL ERROR]:", err);
        await statusMsg.edit(`❌ Critical error: ${err.message}`);
      }
      return;
    }

    // ==========================================
    // AUTO-REPLY CUSTOM EMBED ON MENTION (60s Auto-Delete, No Warning Footer)
    // ==========================================
    if (!message.author.bot && message.mentions.users.size > 0) {
      for (const [userId, user] of message.mentions.users) {
        if (userId === message.author.id) continue;

        const customText = userCustomReplies.get(userId);
        if (!customText) continue;

        const cooldownKey = `${userId}-${message.channel.id}`;
        const lastSent = replyCooldowns.get(cooldownKey) || 0;
        const nowTime = Date.now();

        // 60-second cooldown per channel so it can't be spammed
        if (nowTime - lastSent < 60000) continue;
        replyCooldowns.set(cooldownKey, nowTime);

        const member = await message.guild.members.fetch(userId).catch(() => null);
        const displayName = member ? member.displayName : user.username;
        const avatarUrl = user.displayAvatarURL({ dynamic: true });

        const customEmbed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setAuthor({ name: `${displayName}'s Status`, iconURL: avatarUrl })
          .setDescription(customText);

        try {
          const autoMsg = await message.reply({ embeds: [customEmbed] });

          // Self-delete silently after 60 seconds (no ghost ping trigger)
          setTimeout(async () => {
            botDeletedMessageIds.add(autoMsg.id);
            messageCache.delete(autoMsg.id);
            setTimeout(() => botDeletedMessageIds.delete(autoMsg.id), 30000);
            await autoMsg.delete().catch(() => {});
          }, 60000);
        } catch (e) {
          console.error("Failed to send auto-reply embed:", e.message);
        }
      }
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
