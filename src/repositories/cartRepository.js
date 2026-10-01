class CartRepository {
  constructor(client) {
    this.client = client;
  }

  listProducts(limit, offset) {
    return this.client.product.findMany({
      where: { isActive: true },
      orderBy: { sku: 'asc' },
      take: limit,
      skip: offset,
    });
  }

  createCart(id) {
    return this.client.cart.create({ data: { id, status: 'open' } });
  }

  findCart(id) {
    return this.client.cart.findUnique({
      where: { id },
      include: {
        items: {
          include: { product: true },
          orderBy: { productId: 'asc' },
        },
      },
    });
  }

  findProduct(id) {
    return this.client.product.findUnique({ where: { id } });
  }

  findCartItem(cartId, productId) {
    return this.client.cartItem.findUnique({
      where: { cartId_productId: { cartId, productId } },
    });
  }

  createCartItem(cartId, productId, quantity) {
    return this.client.cartItem.create({
      data: { cartId, productId, quantity },
    });
  }

  updateCartItem(cartId, productId, quantity) {
    return this.client.cartItem.update({
      where: { cartId_productId: { cartId, productId } },
      data: { quantity },
    });
  }

  deleteCartItem(cartId, productId) {
    return this.client.cartItem.delete({
      where: { cartId_productId: { cartId, productId } },
    });
  }

  transaction(work) {
    return this.client.$transaction((transactionClient) =>
      work(new CartRepository(transactionClient)),
    );
  }
}

module.exports = { CartRepository };
