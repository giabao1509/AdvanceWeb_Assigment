import * as oauth from 'openid-client';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { Config } from './config.js';
export { oauth };
export function client(c: Config, id = 'taxi-web') {
  const configuration = new oauth.Configuration({ issuer: c.as, authorization_endpoint: `${c.as}/authorize`, token_endpoint: `${c.as}/token`, jwks_uri: `${c.as}/.well-known/jwks.json`,
    response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic'] }, id, c.clients[id], oauth.ClientSecretBasic(c.clients[id]));
  // Explicit local-lab transport, per user request. Servers only bind loopback.
  oauth.allowInsecureRequests(configuration);
  return configuration;
}
export async function claims(c: Config, token: string) {
  return (await jwtVerify(token, createRemoteJWKSet(new URL(`${c.as}/.well-known/jwks.json`)), { issuer: c.as, audience: 'wallet-api', algorithms: ['ES256'] })).payload;
}
export async function tokenSummary(c: Config, tokens: oauth.TokenEndpointResponse, grant: string) {
  const p = await claims(c, tokens.access_token);
  return { grant, token_type: tokens.token_type, expires_in: tokens.expires_in, refresh_token: Boolean(tokens.refresh_token), sub: p.sub, aud: p.aud, scope: p.scope, principal_type: p.principal_type, exp: p.exp, tokens: '[REDACTED]' };
}
