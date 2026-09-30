'use strict';

const { EmbedBuilder } = require('discord.js');

module.exports = async function statusCmd(client, interaction) {
  await interaction.deferReply({ ephemeral: false });

  const session = client.sessions.get(interaction.guild.id);
  if (!session) {
    return interaction.editReply('ℹ️ No active Shotcaller session.');
  }

  const whisperConfig = client.whisper.getConfig(interaction.guild.id);
  const whisperLines  = Object.entries(whisperConfig)
    .map(([party, uid]) => `Party ${party}: <@${uid}>`)
    .join('\n') || 'Not configured';

  const bridge = client.bridge.getStatus(interaction.guild.id);

  const embed = new EmbedBuilder()
    .setColor(session.muted ? 0xFF0000 : 0x57F287)
    .setTitle('📡 Shotcaller Status')
    .addFields(
      { name: 'Mode',     value: session.mode.toUpperCase(), inline: true },
      { name: 'Parties',  value: String(session.partyCount), inline: true },
      { name: 'Muted',    value: session.muted ? '🔇 Yes' : '🔊 No', inline: true },
      { name: 'Caller',   value: session.dedicatedCaller ? `<@${session.dedicatedCaller}>` : 'Auto', inline: true },
      { name: 'Relays',   value: `${client.relays.connectedCount()} connected`, inline: true },
      { name: 'Bridge',   value: bridge, inline: true },
      { name: 'Whisper Routing', value: whisperLines },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
};
