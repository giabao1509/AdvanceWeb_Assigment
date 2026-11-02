// Fixed identities stand in for the authentication supplied by the course starter.
// They are public demo credentials, not production tokens.
export const identities = ['alice','bob','vera','charlie','admin-alpha','admin-beta'];
export function authenticate(db, header) {
  const match = /^Bearer demo-([a-z-]+)$/.exec(header || '');
  return match && identities.includes(match[1])
    ? db.prepare('SELECT * FROM users WHERE id = ?').get(match[1]) : null;
}
