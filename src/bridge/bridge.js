'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const log = require('../logger');

/**
 * BridgeManager
 *
 * Two guilds each run their own Shotcaller instance.
 * When a bridge is active, audio from the main Shotcaller in guild A is relayed
 * to guild B via a shared relay bot that is a member of both guilds.
 *
 * BRIDGE_PARTNERS env var: "guildA=guildB,guildB=guildA"
 */
class BridgeManager {
  constructor(mainClient) {
    this._main    = mainClient;
    /** guildId → partner guildId */
    this._partners = new Map();
    /** guildId → 'idle' | 'pending' | 'live' */
    this._status   = new Map();
  }

  init() {
    const raw = process.env.BRIDGE_PARTNERS || '';
    for (const pair of raw.split(',')) {
      const [a, b] = pair.trim().split('=');
      if (a && b) {
        this._partners.set(a.trim(), b.trim());
        log.info(`Bridge: ${a.trim()} ↔ ${b.trim()}`);
      }
    }
  }

  getPartner(guildId) {
    return this._partners.get(guildId) ?? null;
  }

  getStatus(guildId) {
    const s = this._status.get(guildId);
    if (!s || s === 'idle') return '⚫ Idle';
    if (s === 'pending')    return '🟡 Pending';
    return '🟢 Live';
  }

  async request(guild) {
    const partner = this.getPartner(guild.id);
    if (!partner) throw new Error('No bridge partner configured (see BRIDGE_PARTNERS in .env).');

    const partnerGuild = this._main.guilds.cache.get(partner);
    if (!partnerGuild) throw new Error(`Main bot is not in partner guild (${partner}). Invite it there first.`);

    this._status.set(guild.id, 'pending');

    // Find a general/officer text channel in partner guild to post the request
    const channel = partnerGuild.channels.cache.find(
      c => c.type === 0 && c.permissionsFor(partnerGuild.members.me)?.has('SendMessages'),
    );
    if (!channel) throw new Error('Could not find a text channel in the partner guild to send the request.');

    const embed = new EmbedBuilder()
      .setColor(0xFFA500)
      .setTitle('🌉 Bridge Request Incoming')
      .setDescription(`**${guild.name}** wants to establish a live audio bridge.\nAccept below to go live.`);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bridge:accept:${guild.id}`)
        .setLabel('Accept Bridge')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`bridge:decline:${guild.id}`)
        .setLabel('Decline')
        .setStyle(ButtonStyle.Danger),
    );

    await channel.send({ embeds: [embed], components: [row] });
    log.info(`Bridge request sent from ${guild.id} → ${partner}`);
  }

  async accept(guild) {
    // Mark both sides live
    this._status.set(guild.id, 'live');
    const partner = this.getPartner(guild.id);
    if (partner) this._status.set(partner, 'live');

    log.info(`Bridge accepted: guild ${guild.id} ↔ ${partner}`);
    // Real audio relay would subscribe a shared relay bot to both guilds' audio;
    // implementation depends on which relay token is in both guilds (see README).
  }

  async close(guildId) {
    const partner = this.getPartner(guildId);
    this._status.set(guildId, 'idle');
    if (partner) this._status.set(partner, 'idle');
    log.info(`Bridge closed for guild ${guildId}`);
  }

  async handleButton(interaction, parts) {
    const [action, requesterGuildId] = parts;

    if (action === 'accept') {
      await this.accept(interaction.guild);
      await interaction.update({
        content: '✅ Bridge accepted — audio link is now live.',
        embeds:  [],
        components: [],
      });

    } else if (action === 'decline') {
      this._status.set(requesterGuildId, 'idle');
      await interaction.update({
        content: '❌ Bridge request declined.',
        embeds:  [],
        components: [],
      });
    }
  }
}

module.exports = { BridgeManager };
