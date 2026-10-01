const { Writable } = require('node:stream');
const { createLogger } = require('../src/config/logger');

describe('structured logger', () => {
  test('writes JSON to its destination and redacts secrets', () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger({ destination });

    logger.info({
      request_id: 'request-id',
      req: { headers: { authorization: 'Bearer secret-token' } },
      body: { password: 'secret-password' },
    }, 'request completed');

    const entry = JSON.parse(output.trim());
    expect(entry).toEqual(expect.objectContaining({
      level: 30,
      request_id: 'request-id',
      msg: 'request completed',
    }));
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('secret-password');
    expect(output).toContain('[REDACTED]');
  });
});
