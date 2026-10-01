const PRODUCTS = Object.freeze({
  keyboard: {
    id: '10000000-0000-4000-8000-000000000001',
    sku: 'KEYBOARD-001',
    name: 'Mechanical Keyboard',
    priceCents: 129900,
    stock: 8,
    isActive: true,
  },
  mouse: {
    id: '10000000-0000-4000-8000-000000000002',
    sku: 'MOUSE-001',
    name: 'Wireless Mouse',
    priceCents: 59900,
    stock: 4,
    isActive: true,
  },
  monitor: {
    id: '10000000-0000-4000-8000-000000000003',
    sku: 'MONITOR-001',
    name: '27-inch Monitor',
    priceCents: 349900,
    stock: 6,
    isActive: true,
  },
  headset: {
    id: '10000000-0000-4000-8000-000000000004',
    sku: 'HEADSET-001',
    name: 'USB Headset',
    priceCents: 89900,
    stock: 0,
    isActive: true,
  },
  legacyWebcam: {
    id: '10000000-0000-4000-8000-000000000005',
    sku: 'WEBCAM-OLD',
    name: 'Legacy Webcam',
    priceCents: 49900,
    stock: 5,
    isActive: false,
  },
});

const CHECKED_OUT_CART_ID = '20000000-0000-4000-8000-000000000001';

module.exports = { PRODUCTS, CHECKED_OUT_CART_ID };
