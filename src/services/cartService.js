const { randomUUID } = require('node:crypto');
const { cartErrors } = require('../errors/cartErrors');

function serializeProduct(product) {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    price_cents: product.priceCents,
    stock: product.stock,
  };
}

function serializeCart(cart) {
  const items = cart.items.map(({ product, quantity }) => ({
    product_id: product.id,
    sku: product.sku,
    name: product.name,
    price_cents: product.priceCents,
    quantity,
    line_total_cents: product.priceCents * quantity,
  }));

  return {
    id: cart.id,
    status: cart.status,
    items,
    subtotal_cents: items.reduce((sum, item) => sum + item.line_total_cents, 0),
  };
}

class CartService {
  constructor(repository) {
    this.repository = repository;
  }

  async listProducts(limit = 20, offset = 0) {
    const products = await this.repository.listProducts(limit, offset);
    return { items: products.map(serializeProduct), limit, offset };
  }

  async createCart() {
    const cart = await this.repository.createCart(randomUUID());
    return { id: cart.id, status: cart.status, items: [], subtotal_cents: 0 };
  }

  async getCart(cartId, repository = this.repository) {
    const cart = await repository.findCart(cartId);
    if (!cart) throw cartErrors.cartNotFound();
    return serializeCart(cart);
  }

  async addItem(cartId, productId, quantity) {
    return this.repository.transaction(async (repository) => {
      const cart = await repository.findCart(cartId);
      this.assertOpenCart(cart);

      const product = await repository.findProduct(productId);
      if (!product || !product.isActive) throw cartErrors.productUnavailable();

      const existing = await repository.findCartItem(cartId, productId);
      if (existing) throw cartErrors.itemAlreadyInCart();
      if (quantity > product.stock) throw cartErrors.insufficientStock();

      await repository.createCartItem(cartId, productId, quantity);
      return this.getCart(cartId, repository);
    });
  }

  async updateItem(cartId, productId, quantity) {
    return this.repository.transaction(async (repository) => {
      const cart = await repository.findCart(cartId);
      this.assertOpenCart(cart);

      const item = await repository.findCartItem(cartId, productId);
      if (!item) throw cartErrors.itemNotFound();

      const product = await repository.findProduct(productId);
      if (!product || !product.isActive) throw cartErrors.productUnavailable();
      if (quantity > product.stock) throw cartErrors.insufficientStock();

      await repository.updateCartItem(cartId, productId, quantity);
      return this.getCart(cartId, repository);
    });
  }

  async deleteItem(cartId, productId) {
    return this.repository.transaction(async (repository) => {
      const cart = await repository.findCart(cartId);
      this.assertOpenCart(cart);

      const item = await repository.findCartItem(cartId, productId);
      if (!item) throw cartErrors.itemNotFound();

      await repository.deleteCartItem(cartId, productId);
    });
  }

  assertOpenCart(cart) {
    if (!cart) throw cartErrors.cartNotFound();
    if (cart.status !== 'open') throw cartErrors.cartClosed();
  }
}

module.exports = { CartService };
