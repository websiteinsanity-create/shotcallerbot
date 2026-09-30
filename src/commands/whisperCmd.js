'use strict';

module.exports = async function whisperCmd(client, interaction) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  if (sub === 'setup') {
    return client.whisper.sendSetupPanel(interaction);
  }

  if (sub === 'set') {
    const party = interaction.options.getInteger('party');
    const user  = interaction.options.getUser('user');
    client.whisper.setWhisperer(interaction.guild.id, party, user.id);
    await interaction.editReply(
      `✅ Party **${party}** whisperer set to <@${user.id}>.`,
    );
  }
};
