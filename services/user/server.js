// User Service :4001. Một DB query cho mỗi request.
import { openDb } from '../../shared/db.js';
import { createApp, listen, sendError } from '../../shared/server.js';

const app = createApp('user');
const db = openDb('user.db');
const byId = db.prepare('SELECT id, name, email, avatar_url AS avatarUrl FROM users WHERE id = ?');

app.get('/users/:id', (req, res) => {
  const user = byId.get(req.params.id);
  if (!user) return sendError(res, 404, 'USER_NOT_FOUND', `Không có user ${req.params.id}`);
  res.json(user);
});

listen(app, 'user');
