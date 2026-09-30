'use strict';

const { InteractionType } = require('discord.js');
const log = require('../logger');

// Sub-command handlers
const shotcallerCmd = require('./shotcallerCmd');
const musicCmd      = require('./musicCmd');
const whisperCmd    = require('./whisperCmd');
const bridgeCmd     = require('./bridgeCmd');
const statusCmd     = require('./statusCmd');

const HANDLERS = {
  shotcaller: shotcallerCmd,
  music:      musicCmd,
  whisper:    whisperCmd,
  bridge:     bridgeCmd,
  status:     statusCmd,
};

async function handleInteraction(client, interaction) {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      const handler = HANDLERS[interaction.commandName];
      if (handler) return handler(client, interaction);
      await interaction.reply({ content: 'Unknown command.', ephemeral: true });
      return;
    }

    // Button interactions (whisper panel, bridge accept, etc.)
    if (interaction.isButton()) {
      const [ns, ...parts] = interaction.customId.split(':');
      if (ns === 'whisper') return client.whisper.handleButton(interaction, parts);
      if (ns === 'bridge')  return client.bridge.handleButton(interaction, parts);
      await interaction.reply({ content: 'Unknown button.', ephemeral: true });
      return;
    }

    // Select menus (whisper party assignment)
    if (interaction.isStringSelectMenu()) {
      const [ns, ...parts] = interaction.customId.split(':');
      if (ns === 'whisper') return client.whisper.handleSelect(interaction, parts);
      await interaction.reply({ content: 'Unknown select menu.', ephemeral: true });
    }
  } catch (err) {
    log.error('Interaction error:', err);
    const msg = { content: '❌ An error occurred.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
}

module.exports = { handleInteraction };
