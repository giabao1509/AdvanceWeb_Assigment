// GraphQL :4020, một endpoint POST /graphql cho cả web và mobile (decisions.md mục 4.6).
// PRODUCT_LOADER=naive   -> mỗi dòng hàng gọi GET /products/:id (N+1, M call)
// PRODUCT_LOADER=batched -> DataLoader theo request, batch + dedup qua GET /products?ids=
import DataLoader from 'dataloader';
import { GraphQLError } from 'graphql';
import { createSchema, createYoga } from 'graphql-yoga';
import { log } from '../shared/context.js';
import { MESSAGES, fatalUpstream } from '../shared/errors.js';
import { createApp, listen } from '../shared/server.js';
import { fetchOrders, fetchProductOne, fetchProductsBatch, fetchUser } from '../shared/upstream.js';

const PRODUCT_LOADER = process.env.PRODUCT_LOADER === 'naive' ? 'naive' : 'batched';

const typeDefs = /* GraphQL */ `
  type Query {
    user(id: ID!): User
    "Cho mobile: không gọi User Service"
    ordersByUser(userId: ID!): [Order!]!
  }
  type User {
    id: ID!
    name: String!
    email: String!
    avatarUrl: String
    orders: [Order!]!
  }
  type Order {
    id: ID!
    status: OrderStatus!
    totalAmount: Int!
    shippingAddress: String
    note: String
    createdAt: String!
    items: [OrderItem!]!
  }
  type OrderItem {
    lineNo: Int!
    quantity: Int!
    "Nullable: Product lỗi thì field này null kèm lỗi trong errors[] (policy P2)"
    product: Product
  }
  type Product {
    id: ID!
    name: String!
    price: Int!
    thumbnailUrl: String!
  }
  enum OrderStatus {
    PENDING
    PAID
    SHIPPED
    DELIVERED
    CANCELLED
  }
`;

const gqlError = (code) => new GraphQLError(MESSAGES[code] ?? code, { extensions: { code } });

async function ordersOf(userId) {
  try {
    return await fetchOrders(userId);
  } catch (err) {
    throw gqlError(fatalUpstream('order', err).code);
  }
}

const toProduct = (r) => r.product ?? gqlError(r.code);

const resolvers = {
  Query: {
    user: async (_, { id }) => {
      let user;
      try {
        user = await fetchUser(id);
      } catch (err) {
        throw gqlError(fatalUpstream('user', err).code);
      }
      if (user === null) throw gqlError('USER_NOT_FOUND');
      return user;
    },
    ordersByUser: (_, { userId }) => ordersOf(userId),
  },
  User: {
    // orders là non-null: Order lỗi thì null lan lên user, tức thất bại toàn bộ.
    orders: (user) => ordersOf(user.id),
  },
  OrderItem: {
    product: async (item, _, ctx) => {
      if (PRODUCT_LOADER === 'naive') {
        const r = await fetchProductOne(item.productId);
        if (r.product) return r.product;
        throw gqlError(r.code);
      }
      return ctx.loadProduct(item.productId);
    },
  },
};

// DataLoader mới cho mỗi request: batch + dedup chỉ trong phạm vi một request.
function createContext() {
  const loader = new DataLoader(async (ids) => {
    const results = await fetchProductsBatch([...ids]);
    return ids.map((id) => toProduct(results.get(id)));
  });
  const seen = new Set();
  return {
    loadProduct(id) {
      if (seen.has(id)) log({ kind: 'cache-hit', key: id });
      else seen.add(id);
      return loader.load(id);
    },
  };
}

const yoga = createYoga({
  schema: createSchema({ typeDefs, resolvers }),
  context: createContext,
  graphqlEndpoint: '/graphql',
  cors: false, // CORS do shared/server.js xử lý, giống mọi server khác
  graphiql: true,
  landingPage: false,
  logging: false,
});

const app = createApp('graphql');
app.get('/__mode', (req, res) => res.json({ productLoader: PRODUCT_LOADER }));
app.use(yoga.graphqlEndpoint, yoga);

listen(app, 'graphql');
console.log(`[graphql] PRODUCT_LOADER=${PRODUCT_LOADER}`);
