'use strict';

const { EmbedBuilder } = require('discord.js');

module.exports = async function musicCmd(client, interaction) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  if (sub === 'list') {
    const tracks = await client.music.listTracks();
    if (!tracks.length) {
      return interaction.editReply('📂 No tracks found in `data/music/`. Add `.mp3`, `.wav`, or `.ogg` files.');
    }
    const embed = new EmbedBuilder()
      .setColor(0x1DB954)
      .setTitle('🎵 Music Library')
      .setDescription(tracks.map((t, i) => `\`${i + 1}.\` ${t}`).join('\n'));
    return interaction.editReply({ embeds: [embed] });
  }

  const session = client.sessions.get(interaction.guild.id);
  if (!session) {
    return interaction.editReply('❌ No active Shotcaller session. Start one first with `/shotcaller start`.');
  }

  if (sub === 'play') {
    const track = interaction.options.getString('track');
    try {
      await client.music.play(session.mainConnection, track);
      await interaction.editReply(`▶️ Now playing: **${track}** (looping)`);
    } catch (err) {
      await interaction.editReply(`❌ ${err.message}`);
    }

  } else if (sub === 'stop') {
    client.music.stop();
    await interaction.editReply('⏹️ Music stopped.');

  } else if (sub === 'restart') {
    try {
      await client.music.restart(session.mainConnection);
      await interaction.editReply('🔁 Track restarted.');
    } catch (err) {
      await interaction.editReply(`❌ ${err.message}`);
    }
  }
};
