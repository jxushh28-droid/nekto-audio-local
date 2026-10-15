import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('token1').setDescription('Save the Nekto auth token for window 1 (stranger A)')
    .addStringOption(option => option.setName('token').setDescription('Nekto auth token for window 1')
      .setRequired(true).setMinLength(1).setMaxLength(4000)),
  new SlashCommandBuilder().setName('token2').setDescription('Save the Nekto auth token for window 2 (stranger B)')
    .addStringOption(option => option.setName('token').setDescription('Nekto auth token for window 2')
      .setRequired(true).setMinLength(1).setMaxLength(4000)),
  new SlashCommandBuilder().setName('join').setDescription('Join your voice channel; open both windows and bridge the two strangers'),
  new SlashCommandBuilder().setName('next').setDescription('End this Nekto call and search for another person'),
  new SlashCommandBuilder().setName('autonext').setDescription('Toggle searching after a partner ends the call')
    .addBooleanOption(option => option.setName('enabled').setDescription('Enable or disable automatic next')),
  new SlashCommandBuilder().setName('proxy').setDescription('Route the browser through a proxy (e.g. socks5://ip:port) or clear it')
    .addStringOption(option => option.setName('url').setDescription('socks5://ip:port, http://user:pass@ip:port, or "off" to clear')
      .setRequired(false).setMaxLength(400)),
  new SlashCommandBuilder().setName('stop').setDescription('Stop Nekto while staying in Discord voice'),
  new SlashCommandBuilder().setName('leave').setDescription('Stop Nekto and leave Discord voice'),
  new SlashCommandBuilder().setName('status').setDescription('Show private relay connection status'),
].map(command => command.setDMPermission(false).toJSON());
