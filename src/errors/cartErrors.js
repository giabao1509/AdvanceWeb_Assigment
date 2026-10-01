const { AppError } = require('./AppError');

const cartErrors = {
  cartNotFound: () => new AppError(404, 'CART_NOT_FOUND', 'Cart not found'),
  itemNotFound: () => new AppError(404, 'ITEM_NOT_FOUND', 'Cart item not found'),
  productUnavailable: () =>
    new AppError(422, 'PRODUCT_UNAVAILABLE', 'Product is unavailable'),
  insufficientStock: () =>
    new AppError(409, 'INSUFFICIENT_STOCK', 'Requested quantity exceeds stock'),
  itemAlreadyInCart: () =>
    new AppError(409, 'ITEM_ALREADY_IN_CART', 'Product is already in the cart'),
  cartClosed: () => new AppError(409, 'CART_CLOSED', 'Cart is closed'),
};

module.exports = { cartErrors };
