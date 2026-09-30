'use strict';

const LEVELS = { info: 'INFO', warn: 'WARN', error: 'ERROR', debug: 'DEBUG' };

function fmt(level, ...args) {
  const ts = new Date().toISOString();
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
    `[${ts}] [${LEVELS[level]}]`, ...args
  );
}

module.exports = {
  info:  (...a) => fmt('info',  ...a),
  warn:  (...a) => fmt('warn',  ...a),
  error: (...a) => fmt('error', ...a),
  debug: (...a) => { if (process.env.DEBUG) fmt('debug', ...a); },
};
