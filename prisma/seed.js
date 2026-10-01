const { PrismaClient } = require('@prisma/client');
const { PRODUCTS, CHECKED_OUT_CART_ID } = require('./fixtures');

const prisma = new PrismaClient();

async function seed() {
  await prisma.cartItem.deleteMany();
  await prisma.cart.deleteMany();
  await prisma.product.deleteMany();

  await prisma.product.createMany({ data: Object.values(PRODUCTS) });
  await prisma.cart.create({
    data: { id: CHECKED_OUT_CART_ID, status: 'checked_out' },
  });
}

if (require.main === module) {
  seed()
    .then(() => prisma.$disconnect())
    .catch(async () => {
      console.error('Database seed failed');
      await prisma.$disconnect();
      process.exitCode = 1;
    });
}

module.exports = { seed };
