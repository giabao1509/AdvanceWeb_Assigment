const express = require('express');

function createCartRouter(service) {
  const router = express.Router();

  router.post('/carts', async (_req, res) => {
    const cart = await service.createCart();
    res.location(`/carts/${cart.id}`).status(201).json(cart);
  });

  router.get('/carts/:cartId', async (req, res) => {
    const cart = await service.getCart(req.params.cartId);
    res.status(200).json(cart);
  });

  router.post('/carts/:cartId/items', async (req, res) => {
    const cart = await service.addItem(
      req.params.cartId,
      req.body.product_id,
      req.body.quantity,
    );
    res.status(201).json(cart);
  });

  router.patch('/carts/:cartId/items/:productId', async (req, res) => {
    const cart = await service.updateItem(
      req.params.cartId,
      req.params.productId,
      req.body.quantity,
    );
    res.status(200).json(cart);
  });

  router.delete('/carts/:cartId/items/:productId', async (req, res) => {
    await service.deleteItem(req.params.cartId, req.params.productId);
    res.status(204).send();
  });

  return router;
}

module.exports = { createCartRouter };
