'use strict';

const { EmbedBuilder } = require('discord.js');
const log = require('../logger');

const MODE_PARTIES = { gvg: 8, full: 12 };

module.exports = async function shotcallerCmd(client, interaction) {
  const sub = interaction.options.getSubcommand();

  // ── Permission check ────────────────────────────────────────────────────────
  const allowedRoles = [
    process.env.SHOTCALLER_ROLE_NAME || 'Shotcaller',
    process.env.OFFICER_ROLE_NAME    || 'Officer',
    process.env.LEADER_ROLE_NAME     || 'Leader',
  ];
  const hasRole = interaction.member.roles.cache.some(r => allowedRoles.includes(r.name));
  if (!hasRole && !interaction.member.permissions.has('Administrator')) {
    return interaction.reply({ content: '❌ You need the Shotcaller, Officer or Leader role.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: false });

  if (sub === 'start') {
    const mode    = interaction.options.getString('mode');
    const parties = mode === 'custom'
      ? (interaction.options.getInteger('parties') ?? 4)
      : MODE_PARTIES[mode];

    try {
      await client.guild.createPartyChannels(interaction.guild, parties);
      await client.sessions.start(client, interaction.guild, interaction.channel, parties, mode);

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎙️ Shotcaller Session Started')
        .addFields(
          { name: 'Mode',    value: mode.toUpperCase(), inline: true },
          { name: 'Parties', value: String(parties),    inline: true },
          { name: 'Status',  value: '🟢 Live',          inline: true },
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      log.error('Failed to start session:', err);
      await interaction.editReply({ content: `❌ Failed to start: ${err.message}` });
    }

  } else if (sub === 'stop') {
    try {
      await client.sessions.stop(client, interaction.guild);
      await client.guild.deletePartyChannels(interaction.guild);
      await interaction.editReply({ content: '🛑 Shotcaller session ended.' });
    } catch (err) {
      log.error('Failed to stop session:', err);
      await interaction.editReply({ content: `❌ Failed to stop: ${err.message}` });
    }

  } else if (sub === 'mute') {
    client.sessions.setMuted(interaction.guild.id, true);
    await interaction.editReply({ content: '🔇 Broadcast muted.' });

  } else if (sub === 'unmute') {
    client.sessions.setMuted(interaction.guild.id, false);
    await interaction.editReply({ content: '🔊 Broadcast unmuted.' });

  } else if (sub === 'caller') {
    const user = interaction.options.getUser('user');
    client.sessions.setDedicatedCaller(interaction.guild.id, user?.id ?? null);
    await interaction.editReply({
      content: user
        ? `🎤 Dedicated caller set to <@${user.id}>.`
        : '🎤 Dedicated caller cleared — auto-speaker active.',
    });
  }
};
