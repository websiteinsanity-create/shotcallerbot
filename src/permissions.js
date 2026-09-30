const { PermissionFlagsBits } = require("discord.js");
const c = require("./config");
const hasRole = (m,n) => m.roles?.cache?.some(r => r.name.toLowerCase() === n.toLowerCase());
const admin = m => m.permissions?.has(PermissionFlagsBits.Administrator);
const canUse = m => admin(m) || hasRole(m,c.shotcallerRoleName) || hasRole(m,c.officerRoleName) || hasRole(m,c.leaderRoleName);
const canBridge = m => admin(m) || hasRole(m,c.officerRoleName) || hasRole(m,c.leaderRoleName);
const canWhisper = m => admin(m) || hasRole(m,c.whisperRoleName) || hasRole(m,c.officerRoleName) || hasRole(m,c.leaderRoleName);
module.exports = { canUse, canBridge, canWhisper };
