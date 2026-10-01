const express = require('express');

function createProductRouter(service) {
  const router = express.Router();

  router.get('/products', async (req, res) => {
    const result = await service.listProducts(req.query.limit ?? 20, req.query.offset ?? 0);
    res.status(200).json(result);
  });

  return router;
}

module.exports = { createProductRouter };
