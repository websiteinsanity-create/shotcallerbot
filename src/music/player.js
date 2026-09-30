'use strict';

const path = require('path');
const fs   = require('fs');
const {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const log = require('../logger');

const MUSIC_DIR = path.join(__dirname, '..', '..', 'data', 'music');
const SUPPORTED = ['.mp3', '.wav', '.ogg'];

class MusicPlayer {
  constructor() {
    this._player      = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this._currentTrack = null;
    this._connection   = null;
    this._looping      = false;
    this._ffmpegProc   = null;

    this._player.on(AudioPlayerStatus.Idle, () => {
      if (this._looping && this._currentTrack && this._connection) {
        log.debug(`Music looping: ${this._currentTrack}`);
        this._startStream(this._connection, this._currentTrack);
      }
    });

    this._player.on('error', (err) => log.error('AudioPlayer error:', err));
  }

  async listTracks() {
    try {
      await fs.promises.mkdir(MUSIC_DIR, { recursive: true });
      const files = await fs.promises.readdir(MUSIC_DIR);
      return files.filter(f => SUPPORTED.includes(path.extname(f).toLowerCase()));
    } catch {
      return [];
    }
  }

  async play(connection, trackName) {
    const tracks = await this.listTracks();
    // Match by full name or without extension
    const file = tracks.find(t =>
      t === trackName ||
      t.replace(/\.[^.]+$/, '') === trackName
    );
    if (!file) throw new Error(`Track not found: "${trackName}". Use \`/music list\` to see available tracks.`);

    this._currentTrack = file;
    this._connection   = connection;
    this._looping      = true;

    this._startStream(connection, file);
  }

  _startStream(connection, file) {
    // Kill previous FFmpeg if running
    if (this._ffmpegProc) {
      this._ffmpegProc.kill('SIGKILL');
      this._ffmpegProc = null;
    }

    const filePath = path.join(MUSIC_DIR, file);
    const pass = new PassThrough();

    const proc = spawn('ffmpeg', [
      '-i', filePath,
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    proc.stdout.pipe(pass);
    proc.on('error', err => log.error('FFmpeg error:', err));
    this._ffmpegProc = proc;

    const resource = createAudioResource(pass, { inlineVolume: false });
    connection.subscribe(this._player);
    this._player.play(resource);
    log.info(`Music started: ${file}`);
  }

  stop() {
    this._looping = false;
    if (this._ffmpegProc) {
      this._ffmpegProc.kill('SIGKILL');
      this._ffmpegProc = null;
    }
    this._player.stop();
    this._currentTrack = null;
    log.info('Music stopped');
  }

  async restart(connection) {
    if (!this._currentTrack) throw new Error('No track is currently loaded.');
    this._startStream(connection || this._connection, this._currentTrack);
  }
}

module.exports = { MusicPlayer };
