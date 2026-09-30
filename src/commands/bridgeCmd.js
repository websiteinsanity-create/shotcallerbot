'use strict';

module.exports = async function bridgeCmd(client, interaction) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: false });

  if (sub === 'request') {
    try {
      await client.bridge.request(interaction.guild);
      await interaction.editReply('🌉 Bridge request sent to partner guild.');
    } catch (err) {
      await interaction.editReply(`❌ ${err.message}`);
    }

  } else if (sub === 'accept') {
    try {
      await client.bridge.accept(interaction.guild);
      await interaction.editReply('✅ Bridge accepted — live link established.');
    } catch (err) {
      await interaction.editReply(`❌ ${err.message}`);
    }

  } else if (sub === 'close') {
    await client.bridge.close(interaction.guild.id);
    await interaction.editReply('🔌 Bridge closed.');
  }
};
