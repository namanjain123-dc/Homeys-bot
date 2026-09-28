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

// Bots to IGNORE during embed backups
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

// Promise wrapper with strict 4s timeout so it NEVER hangs
function timeoutPromise(promise, ms = 4000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Operation Timed Out")), ms))
  ]);
}

// Clean normalize helper for channel & category names
function normalizeName(str) {
  return (str || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// --- 1. Message Create Handler ---
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    // ==========================================
    // COMMAND: .purge <amount>
    // ==========================================
    if (message.content.trim().toLowerCase().startsWith(".purge")) {
      if (
        !message.member.permissions.has(PermissionsBitField.Flags.ManageMessages) &&
        !message.member.permissions.has(PermissionsBitField.Flags.Administrator)
      ) {
        return message.reply("❌ You need the **Manage Messages** permission to use `.purge`.");
      }

      const args = message.content.trim().split(/\s+/);
      const count = parseInt(args[1], 10);

      if (isNaN(count) || count < 1 || count > 100) {
        return message.reply("❌ Please provide a valid number between **1** and **100**.\n*Example:* `.purge 20`");
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
        message.channel.send("❌ Could not purge messages (Discord cannot bulk-delete messages older than 14 days).")
          .then((m) => setTimeout(() => m.delete().catch(() => {}), 5000));
      }
      return;
    }

    // ==========================================
    // COMMAND: !backupserver & !backupembeds
    // ==========================================
    if (
      message.content.trim().toLowerCase().startsWith("!backupserver") ||
      message.content.trim().toLowerCase().startsWith("!backupembeds")
    ) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("❌ Only administrators can run this command.");
      }

      const statusMsg = await message.reply("⏳ Creating clean server snapshot...");

      try {
        const guild = message.guild;

        const roles = await guild.roles.fetch();
        const roleData = roles
          .filter((r) => r.id !== guild.id && !r.managed && r.name !== "@everyone")
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
          content: `✅ **Server Snapshot Complete!**\n• Roles: **${roleData.length}**\n• Channels & Categories: **${channelData.length}**\n• Embeds captured: **${embedData.length}**\n\nRun \`!restoreserver\` with this attached file to rebuild everything.`,
          files: [attachment]
        });
      } catch (err) {
        console.error("Backup failed:", err);
        await statusMsg.edit("❌ Failed to compile server backup.");
      }
      return;
    }

    // ==========================================
    // COMMAND: !restoreserver (FULL REBUILD GUARANTEED)
    // ==========================================
    if (message.content.trim().toLowerCase().startsWith("!restoreserver")) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("❌ Only administrators can run this command.");
      }

      const file = message.attachments.find((att) => att.name.endsWith(".json"));
      if (!file) {
        return message.reply("❌ Please upload your `server-full-backup.json` file together with `!restoreserver`.");
      }

      console.log(`[RESTORE INITIATED] Downloading file: ${file.url}`);
      const statusMsg = await message.reply("⏳ Downloading backup and rebuilding server...");

      try {
        const res = await fetch(file.url);
        const text = await res.text();
        const snapshot = JSON.parse(text);

        const guild = message.guild;
        let createdRoles = 0;
        let createdChannels = 0;
        let restoredEmbeds = 0;

        console.log(`[RESTORE] Snapshot loaded for: ${snapshot.guildName}`);

        // Fetch current server state once
        let currentRoles = await guild.roles.fetch();
        let currentChannels = await guild.channels.fetch();

        // ------------------------------------------
        // STEP 1: Rebuild Roles
        // ------------------------------------------
        if (snapshot.roles && Array.isArray(snapshot.roles)) {
          for (const r of snapshot.roles) {
            try {
              if (r.name === "@everyone") continue;
              const exists = currentRoles.some((ex) => normalizeName(ex.name) === normalizeName(r.name));

              if (!exists) {
                console.log(`[ROLE] Creating: ${r.name}`);
                await timeoutPromise(
                  guild.roles.create({
                    name: r.name,
                    color: r.color,
                    hoist: r.hoist,
                    mentionable: r.mentionable,
                    permissions: BigInt(r.permissions),
                    reason: "Full server restore"
                  }),
                  4000
                );
                createdRoles++;
                await new Promise((resolve) => setTimeout(resolve, 350));
              }
            } catch (err) {
              console.warn(`[ROLE WARN] Skipping role ${r.name}: ${err.message}`);
            }
          }
        }

        // ------------------------------------------
        // STEP 2: Rebuild Categories
        // ------------------------------------------
        currentChannels = await guild.channels.fetch();
        const categoryMap = new Map(); // normalized category name -> channel ID

        const categories = (snapshot.channels || []).filter((c) => c.type === ChannelType.GuildCategory);
        for (const cat of categories) {
          try {
            const normCatName = normalizeName(cat.name);
            let catObj = currentChannels.find(
              (c) => c && c.type === ChannelType.GuildCategory && normalizeName(c.name) === normCatName
            );

            if (!catObj) {
              console.log(`[CAT] Creating Category: ${cat.name}`);
              catObj = await timeoutPromise(
                guild.channels.create({
                  name: cat.name,
                  type: ChannelType.GuildCategory,
                  reason: "Full server restore"
                }),
                4000
              );
              createdChannels++;
              await new Promise((resolve) => setTimeout(resolve, 350));
            }
            categoryMap.set(normCatName, catObj.id);
          } catch (err) {
            console.warn(`[CAT WARN] Category ${cat.name}: ${err.message}`);
          }
        }

        // ------------------------------------------
        // STEP 3: Rebuild Channels
        // ------------------------------------------
        currentChannels = await guild.channels.fetch();
        const normalChannels = (snapshot.channels || []).filter((c) => c.type !== ChannelType.GuildCategory);

        for (const ch of normalChannels) {
          try {
            const normChName = normalizeName(ch.name);
            let chObj = currentChannels.find(
              (c) => c && c.type !== ChannelType.GuildCategory && normalizeName(c.name) === normChName
            );

            const parentId = ch.parentName ? categoryMap.get(normalizeName(ch.parentName)) : null;

            if (!chObj) {
              // Convert GuildAnnouncement (type 5) to GuildText (type 0) to avoid Community rejection
              const safeType = ch.type === ChannelType.GuildAnnouncement ? ChannelType.GuildText : ch.type;
              console.log(`[CHANNEL] Creating #${ch.name}`);

              chObj = await timeoutPromise(
                guild.channels.create({
                  name: ch.name,
                  type: safeType,
                  topic: ch.topic || undefined,
                  nsfw: ch.nsfw || false,
                  rateLimitPerUser: ch.rateLimitPerUser || 0,
                  parent: parentId || undefined,
                  reason: "Full server restore"
                }),
                4000
              );

              createdChannels++;
              await new Promise((resolve) => setTimeout(resolve, 350));
            } else if (parentId && chObj.parentId !== parentId) {
              await chObj.setParent(parentId).catch(() => {});
            }
          } catch (err) {
            console.warn(`[CHANNEL WARN] Skipping #${ch.name}: ${err.message}`);
          }
        }

        // ------------------------------------------
        // STEP 4: Restore All Custom Embeds
        // ------------------------------------------
        console.log(`[EMBEDS] Starting embed restoration...`);
        const freshChannels = await guild.channels.fetch();

        if (snapshot.embeds && Array.isArray(snapshot.embeds)) {
          for (const item of snapshot.embeds) {
            try {
              const targetChannel = freshChannels.find(
                (c) =>
                  c &&
                  (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
                  normalizeName(c.name) === normalizeName(item.channelName)
              );

              if (!targetChannel) {
                console.log(`[SKIP EMBED] Target channel #${item.channelName} could not be matched.`);
                continue;
              }

              for (const embedData of item.embeds) {
                try {
                  const embed = new EmbedBuilder(embedData);
                  await timeoutPromise(targetChannel.send({ embeds: [embed] }), 4000);
                  restoredEmbeds++;
                  console.log(`[EMBED OK] Posted embed into #${targetChannel.name}`);
                  await new Promise((resolve) => setTimeout(resolve, 600));
                } catch (e) {
                  console.warn(`[EMBED FAILED] In #${targetChannel.name}: ${e.message}`);
                }
              }
            } catch (err) {
              console.error(`[EMBED ERROR] In #${item.channelName}:`, err.message);
            }
          }
        }

        console.log(`[RESTORE FINISHED] Success! Roles: ${createdRoles}, Channels: ${createdChannels}, Embeds: ${restoredEmbeds}`);

        await statusMsg.edit(
          `✅ **Full Server Recovery Complete!**\n• Roles verified/added: **${createdRoles}**\n• Channels & Categories created: **${createdChannels}**\n• Embeds re-posted: **${restoredEmbeds}**`
        );
      } catch (err) {
        console.error("[CRITICAL RESTORE FAILURE]:", err);
        await statusMsg.edit(`❌ Critical restore failure: ${err.message}`);
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
