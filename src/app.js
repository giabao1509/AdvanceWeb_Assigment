const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const pinoHttp = require('pino-http');
const swaggerUi = require('swagger-ui-express');
const OpenApiValidator = require('express-openapi-validator');
const YAML = require('yaml');
const fs = require('node:fs');
const { createLogger } = require('./config/logger');
const { prisma } = require('./database/prisma');
const { CartRepository } = require('./repositories/cartRepository');
const { CartService } = require('./services/cartService');
const { createRouter } = require('./routes');
const { errorHandler } = require('./middleware/errorHandler');

const apiSpecPath = path.join(__dirname, '..', 'openapi.yaml');
const apiDocument = YAML.parse(fs.readFileSync(apiSpecPath, 'utf8'));

function createApp(options = {}) {
  const app = express();
  const logger = options.logger || createLogger();
  const repository = options.repository || new CartRepository(prisma);
  const service = new CartService(repository);

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      customProps: (req) => ({ request_id: req.id }),
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress,
        }),
        res: (res) => ({ statusCode: res.statusCode }),
        err: (error) => ({ type: error.name || error.type || 'Error' }),
      },
    }),
  );
  app.use(express.json());

  app.use('/docs', swaggerUi.serve, swaggerUi.setup(apiDocument));

  app.use(
    OpenApiValidator.middleware({
      apiSpec: apiSpecPath,
      validateRequests: {
        coerceTypes: false,
        removeAdditional: false,
        allowUnknownQueryParameters: false,
      },
      validateResponses: true,
    }),
  );

  app.use(createRouter(service));
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
