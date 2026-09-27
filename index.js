const {
    Client,
    GatewayIntentBits
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;

const ROLE_NAME = "homeys";
const COOLDOWN = 60 * 60 * 1000;
const TIMEOUT_DURATION = 7 * 24 * 60 * 60 * 1000;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const serverData = new Map();

client.once("ready", () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
    if (!message.guild) return;
    if (message.author.id === client.user.id) return;

    const role = message.guild.roles.cache.find(
        r => r.name.toLowerCase() === ROLE_NAME.toLowerCase()
    );

    if (!role) return;
    if (!message.mentions.roles.has(role.id)) return;

    const guildId = message.guild.id;
    const userId = message.author.id;
    const now = Date.now();

    if (!serverData.has(guildId)) {
        serverData.set(guildId, {
            lastPing: null,
            violations: new Map()
        });
    }

    const data = serverData.get(guildId);

    // First ping, or cooldown has expired
    if (!data.lastPing || now - data.lastPing >= COOLDOWN) {
        data.lastPing = now;
        data.violations.clear();

        console.log(
            `@${role.name} ping allowed by ${message.author.tag}`
        );

        return;
    }

    // Ping attempted during cooldown
    const violations = (data.violations.get(userId) || 0) + 1;
    data.violations.set(userId, violations);

    try {
        await message.delete();
    } catch (error) {
        console.error("Could not delete message:", error);
    }

    // Second violation
    if (violations >= 2) {

        // Bot → kick
        if (message.author.bot) {
            try {
                await message.guild.members.kick(
                    userId,
                    "Repeatedly pinging @homeys during cooldown"
                );

                console.log(
                    `Bot ${message.author.tag} kicked.`
                );
            } catch (error) {
                console.error("Could not kick bot:", error);
            }

            return;
        }

        // Human → 7 day timeout
        try {
            const member = await message.guild.members.fetch(userId);

            if (member.moderatable) {
                await member.timeout(
                    TIMEOUT_DURATION,
                    "Repeatedly pinging @homeys during cooldown"
                );

                console.log(
                    `${message.author.tag} timed out for 7 days.`
                );
            }
        } catch (error) {
            console.error("Could not timeout member:", error);
        }

        return;
    }

    // First violation warning
    const remaining = COOLDOWN - (now - data.lastPing);
    const minutes = Math.ceil(remaining / 60000);

    try {
        const warning = await message.channel.send(
            `${message.author}, **@${role.name}** is on cooldown. ` +
            `You can ping it again in **${minutes} minute(s)**. ` +
            `⚠️ Another attempt will result in a **7-day timeout**.`
        );

        setTimeout(() => {
            warning.delete().catch(() => {});
        }, 5000);
    } catch (error) {
        console.error("Could not send warning:", error);
    }
});

client.login(TOKEN);
