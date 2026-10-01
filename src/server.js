const { createApp } = require('./app');
const { createLogger } = require('./config/logger');
const { prisma } = require('./database/prisma');

const port = Number(process.env.PORT || 3000);
const logger = createLogger();
const app = createApp({ logger });
const server = app.listen(port, () => {
  logger.info({ port }, 'Cart API listening');
});

async function shutdown() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
