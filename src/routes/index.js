const express = require('express');
const { createCartRouter } = require('./cartRoutes');
const { createProductRouter } = require('./productRoutes');

function createRouter(service) {
  const router = express.Router();

  router.use(createProductRouter(service));
  router.use(createCartRouter(service));

  return router;
}

module.exports = { createRouter };
