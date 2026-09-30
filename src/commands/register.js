'use strict';

const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const log = require('../logger');

const commands = [
  // ── Shotcaller session ─────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('shotcaller')
    .setDescription('Shotcaller session management')
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addSubcommand(sub => sub
      .setName('start')
      .setDescription('Start a Shotcaller session')
      .addStringOption(opt => opt
        .setName('mode')
        .setDescription('Session mode')
        .setRequired(true)
        .addChoices(
          { name: 'GvG (8 parties)', value: 'gvg' },
          { name: 'Full Guild (12 parties)', value: 'full' },
          { name: 'Custom', value: 'custom' },
        ))
      .addIntegerOption(opt => opt
        .setName('parties')
        .setDescription('Number of party channels (custom mode, 1–12)')
        .setMinValue(1)
        .setMaxValue(12)))
    .addSubcommand(sub => sub
      .setName('stop')
      .setDescription('Stop the current Shotcaller session'))
    .addSubcommand(sub => sub
      .setName('mute')
      .setDescription('Mute the main Shotcaller broadcast'))
    .addSubcommand(sub => sub
      .setName('unmute')
      .setDescription('Unmute the main Shotcaller broadcast'))
    .addSubcommand(sub => sub
      .setName('caller')
      .setDescription('Set the dedicated caller (overrides auto-speaker)')
      .addUserOption(opt => opt
        .setName('user')
        .setDescription('The user to designate as caller (leave blank to clear)'))),

  // ── Music ─────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('music')
    .setDescription('Music controls')
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addSubcommand(sub => sub
      .setName('play')
      .setDescription('Play a track from the music library')
      .addStringOption(opt => opt
        .setName('track')
        .setDescription('Track filename (without extension)')
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('stop')
      .setDescription('Stop music playback'))
    .addSubcommand(sub => sub
      .setName('restart')
      .setDescription('Restart the current track'))
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('List available tracks in the music library')),

  // ── Whisper ───────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('whisper')
    .setDescription('Whisper routing configuration')
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addSubcommand(sub => sub
      .setName('setup')
      .setDescription('Open the whisper setup panel'))
    .addSubcommand(sub => sub
      .setName('set')
      .setDescription('Assign a whisperer to a party (parties 2–12)')
      .addIntegerOption(opt => opt
        .setName('party')
        .setDescription('Party number (2–12)')
        .setRequired(true)
        .setMinValue(2)
        .setMaxValue(12))
      .addUserOption(opt => opt
        .setName('user')
        .setDescription('User to assign as whisperer')
        .setRequired(true))),

  // ── Bridge ────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('bridge')
    .setDescription('Cross-guild bridge controls')
    .setDefaultMemberPermissions(PermissionFlagsBits.MoveMembers)
    .addSubcommand(sub => sub
      .setName('request')
      .setDescription('Request a bridge with the partner guild'))
    .addSubcommand(sub => sub
      .setName('accept')
      .setDescription('Accept an incoming bridge request'))
    .addSubcommand(sub => sub
      .setName('close')
      .setDescription('Close an active bridge')),

  // ── Status ────────────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show current session status'),
].map(c => c.toJSON());

async function registerCommands(client) {
  const rest = new REST({ version: '10' }).setToken(process.env.MAIN_BOT_TOKEN);
  try {
    if (process.env.DEV_GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.DEV_GUILD_ID),
        { body: commands },
      );
      log.info(`Slash commands registered to dev guild ${process.env.DEV_GUILD_ID}`);
    } else {
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands },
      );
      log.info('Slash commands registered globally');
    }
  } catch (err) {
    log.error('Failed to register slash commands:', err);
  }
}

module.exports = { registerCommands };
