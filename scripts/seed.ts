import { openBaselineInventory, openBaselineOrder, openSecureInventory, openSecureOrder, resetBaselineOrder, resetInventory, resetSecureOrder } from '../src/shared/database.js';

const baselineInventory = openBaselineInventory();
const baselineOrder = openBaselineOrder();
const secureInventory = openSecureInventory();
const secureOrder = openSecureOrder();
resetInventory(baselineInventory, false);
resetBaselineOrder(baselineOrder);
resetInventory(secureInventory, true);
resetSecureOrder(secureOrder);
for (const db of [baselineInventory, baselineOrder, secureInventory, secureOrder]) db.close();
console.log('Baseline and secure fixtures seeded.');
