const pino = require('pino');

function createLogger(options = {}) {
  const {
    destination = process.stdout,
    ...pinoOptions
  } = options;

  return pino({
    level: process.env.LOG_LEVEL || 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.token',
        '*.secret',
      ],
      censor: '[REDACTED]',
    },
    ...pinoOptions,
  }, destination);
}

module.exports = { createLogger };
