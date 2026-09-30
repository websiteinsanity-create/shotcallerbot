'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const log = require('../logger');

const CATEGORY_NAME = () => process.env.PARTY_CATEGORY_NAME || 'Shotcaller Parties';

/**
 * GuildManager
 *
 * Handles Discord guild-side setup:
 *   • Create/delete the Shotcaller Parties category
 *   • Create/delete numbered party voice channels inside it
 *   • Ensure required roles exist (Shotcaller, Officer, Leader, Whisper)
 */
class GuildManager {
  constructor(mainClient) {
    this._main = mainClient;
  }

  // ── Roles ──────────────────────────────────────────────────────────────────

  async ensureRoles(guild) {
    const roleNames = [
      process.env.SHOTCALLER_ROLE_NAME || 'Shotcaller',
      process.env.OFFICER_ROLE_NAME    || 'Officer',
      process.env.LEADER_ROLE_NAME     || 'Leader',
      process.env.WHISPER_ROLE_NAME    || 'Whisper',
    ];

    for (const name of roleNames) {
      const existing = guild.roles.cache.find(r => r.name === name);
      if (!existing) {
        await guild.roles.create({ name, reason: 'Shotcaller auto-setup' });
        log.info(`Created role: ${name}`);
      }
    }
  }

  // ── Channels ───────────────────────────────────────────────────────────────

  async createPartyChannels(guild, count) {
    await this.ensureRoles(guild);

    // Create or find the category
    let category = guild.channels.cache.find(
      c => c.name === CATEGORY_NAME() && c.type === ChannelType.GuildCategory,
    );
    if (!category) {
      category = await guild.channels.create({
        name: CATEGORY_NAME(),
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          {
            id:   guild.roles.everyone.id,
            deny: [PermissionFlagsBits.SendMessages],
          },
        ],
        reason: 'Shotcaller session start',
      });
      log.info(`Created category: ${CATEGORY_NAME()}`);
    }

    // Delete stale party channels if any exist under this category
    const stale = guild.channels.cache.filter(
      c => c.parentId === category.id && c.type === ChannelType.GuildVoice,
    );
    await Promise.all(stale.map(c => c.delete('Shotcaller: clearing stale channels')));

    // Create fresh numbered channels
    for (let i = 1; i <= count; i++) {
      await guild.channels.create({
        name:      `Party ${i}`,
        type:      ChannelType.GuildVoice,
        parent:    category.id,
        position:  i - 1,
        userLimit: 0,
        reason:    `Shotcaller: party ${i}`,
      });
    }

    log.info(`Created ${count} party channels under "${CATEGORY_NAME()}"`);
  }

  async deletePartyChannels(guild) {
    const category = guild.channels.cache.find(
      c => c.name === CATEGORY_NAME() && c.type === ChannelType.GuildCategory,
    );
    if (!category) return;

    const children = guild.channels.cache.filter(c => c.parentId === category.id);
    await Promise.all(children.map(c => c.delete('Shotcaller: session ended')));
    await category.delete('Shotcaller: session ended');
    log.info(`Deleted party channels and category "${CATEGORY_NAME()}"`);
  }
}

module.exports = { GuildManager };
