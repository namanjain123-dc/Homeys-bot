    // ==========================================
    // COMMAND: !backupserver (Captures Full Channel Permissions)
    // ==========================================
    if (
      message.content.trim().toLowerCase().startsWith("!backupserver") ||
      message.content.trim().toLowerCase().startsWith("!backupembeds")
    ) {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply("❌ Only administrators can run this command.");
      }

      const statusMsg = await message.reply("⏳ Creating clean snapshot (roles, channel permissions, embeds)...");

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

        // 2. Channels + Permissions
        const channels = await guild.channels.fetch();
        const categories = channels.filter((c) => c && c.type === ChannelType.GuildCategory);
        const nonCategories = channels.filter((c) => c && c.type !== ChannelType.GuildCategory);

        const channelData = [];

        // Helper to serialize permissions
        const getOverwrites = (ch) => {
          if (!ch.permissionOverwrites) return [];
          return ch.permissionOverwrites.cache.map((ow) => {
            let targetName = null;
            if (ow.type === 0) { // Role overwrite
              const r = roles.get(ow.id);
              targetName = r ? r.name : (ow.id === guild.id ? "@everyone" : null);
            }
            return {
              id: ow.id,
              type: ow.type,
              targetName: targetName,
              allow: ow.allow.bitfield.toString(),
              deny: ow.deny.bitfield.toString()
            };
          }).filter((ow) => ow.targetName !== null);
        };

        for (const [_, cat] of categories) {
          channelData.push({
            id: cat.id,
            name: cat.name,
            type: cat.type,
            rawPosition: cat.rawPosition,
            permissionOverwrites: getOverwrites(cat)
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
            permissionOverwrites: getOverwrites(ch)
          });
        }

        // 3. Custom Embeds
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
          content: `✅ **Clean Server Snapshot Complete!**\n• Roles: **${roleData.length}**\n• Channels & Categories (with custom permissions): **${channelData.length}**\n• Clean Server Embeds: **${embedData.length}**`,
          files: [attachment]
        });
      } catch (err) {
        console.error("Backup failed:", err);
        await statusMsg.edit("❌ Failed to compile server backup.");
      }
      return;
    }

    // ==========================================
    // COMMAND: !restoreserver (Syncs Channel Settings & Permissions)
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
      const statusMsg = await message.reply("⏳ Restoring server layout, channel settings, and permissions...");

      try {
        const response = await fetch(file.url);
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);
        const snapshot = await response.json();

        const guild = message.guild;
        let createdRoles = 0;
        let createdChannels = 0;
        let restoredEmbeds = 0;

        const existingRoles = await guild.roles.fetch();
        const existingChannels = await guild.channels.fetch();

        // Helper to rebuild permission overwrite array
        const resolveOverwrites = (overwrites) => {
          if (!overwrites || !Array.isArray(overwrites)) return [];
          const resolved = [];
          for (const ow of overwrites) {
            let targetId = null;
            if (ow.targetName === "@everyone") {
              targetId = guild.id;
            } else {
              const matchedRole = existingRoles.find((r) => r.name.toLowerCase() === ow.targetName.toLowerCase());
              if (matchedRole) targetId = matchedRole.id;
            }

            if (targetId) {
              resolved.push({
                id: targetId,
                type: ow.type,
                allow: BigInt(ow.allow || 0),
                deny: BigInt(ow.deny || 0)
              });
            }
          }
          return resolved;
        };

        // 1. Roles
        if (snapshot.roles && Array.isArray(snapshot.roles)) {
          for (const r of snapshot.roles) {
            try {
              const match = existingRoles.find((ex) => ex.name.toLowerCase() === r.name.toLowerCase());
              if (!match) {
                console.log(`[RESTORE ROLE] Creating: ${r.name}`);
                await withTimeout(
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
            const overwrites = resolveOverwrites(cat.permissionOverwrites);

            if (!catObj) {
              console.log(`[RESTORE CATEGORY] Creating: ${cat.name}`);
              catObj = await withTimeout(
                guild.channels.create({
                  name: cat.name,
                  type: ChannelType.GuildCategory,
                  permissionOverwrites: overwrites,
                  reason: "Restored from backup"
                }),
                3500
              );
              createdChannels++;
              await new Promise((res) => setTimeout(res, 350));
            } else if (overwrites.length > 0) {
              // Sync permissions on already existing category
              await catObj.permissionOverwrites.set(overwrites).catch(() => {});
            }
            categoryMap.set(cat.name.toLowerCase(), catObj.id);
          } catch (err) {
            console.error(`[CAT ERROR] ${cat.name}:`, err.message);
          }
        }

        // 3. Channels (with Permission & Topic syncing)
        const normalChannels = (snapshot.channels || []).filter((c) => c.type !== ChannelType.GuildCategory);
        for (const ch of normalChannels) {
          try {
            let chObj = existingChannels.find(
              (c) => c && c.name.toLowerCase() === ch.name.toLowerCase()
            );
            const parentId = ch.parentName ? categoryMap.get(ch.parentName.toLowerCase()) : null;
            const overwrites = resolveOverwrites(ch.permissionOverwrites);
            const safeType = ch.type === ChannelType.GuildAnnouncement ? ChannelType.GuildText : ch.type;

            if (!chObj) {
              console.log(`[RESTORE CHANNEL] Creating #${ch.name}`);
              await withTimeout(
                guild.channels.create({
                  name: ch.name,
                  type: safeType,
                  topic: ch.topic || undefined,
                  nsfw: ch.nsfw,
                  rateLimitPerUser: ch.rateLimitPerUser,
                  parent: parentId || undefined,
                  permissionOverwrites: overwrites,
                  reason: "Restored from backup"
                }),
                3500
              );
              createdChannels++;
              await new Promise((res) => setTimeout(res, 350));
            } else {
              // Channel exists: sync topic, slowmode, and permissions
              console.log(`[RESTORE CHANNEL] Syncing settings for existing #${ch.name}`);
              if (parentId && chObj.parentId !== parentId) await chObj.setParent(parentId).catch(() => {});
              if (ch.topic && chObj.topic !== ch.topic) await chObj.setTopic(ch.topic).catch(() => {});
              if (ch.rateLimitPerUser !== undefined) await chObj.setRateLimitPerUser(ch.rateLimitPerUser).catch(() => {});
              if (overwrites.length > 0) await chObj.permissionOverwrites.set(overwrites).catch(() => {});
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
                await withTimeout(targetChannel.send({ embeds: [embed] }), 3500);
                restoredEmbeds++;
                await new Promise((res) => setTimeout(res, 500));
              }
            } catch (err) {
              console.error(`[EMBED ERROR] #${item.channelName}:`, err.message);
            }
          }
        }

        await statusMsg.edit(
          `✅ **Server Rebuild Complete!**\n• Roles added: **${createdRoles}**\n• Channels & settings synced: **${createdChannels}**\n• Embeds re-posted: **${restoredEmbeds}**`
        );
      } catch (err) {
        console.error("[RESTORE CRITICAL ERROR]:", err);
        await statusMsg.edit(`❌ Critical error: ${err.message}`);
      }
      return;
    }
