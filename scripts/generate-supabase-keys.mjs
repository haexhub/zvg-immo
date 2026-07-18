#!/usr/bin/env node
// One-off generator for the self-hosted Supabase stack's secrets: a fresh
// JWT signing secret, plus the two static HS256 JWTs ("API keys") that Kong
// checks incoming requests against (see supabase/kong/kong.yml) and that
// GoTrue/PostgREST verify. Pure node:crypto — a JWT is just two base64url
// JSON blobs and an HMAC signature, no library needed for this.
//
// Usage: node scripts/generate-supabase-keys.mjs
// Paste the printed lines into .env (see .env.example).

import { createHmac, randomBytes } from 'node:crypto'

function base64url(input) {
  return Buffer.from(input).toString('base64url')
}

function signJwt(payload, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${signature}`
}

const jwtSecret = randomBytes(32).toString('hex')
const issuedAt = Math.floor(Date.now() / 1000)
const tenYears = 10 * 365 * 24 * 60 * 60
const claims = { iss: 'zvg-immo', iat: issuedAt, exp: issuedAt + tenYears }

const anonKey = signJwt({ ...claims, role: 'anon' }, jwtSecret)
const serviceRoleKey = signJwt({ ...claims, role: 'service_role' }, jwtSecret)

console.log(`SUPABASE_JWT_SECRET=${jwtSecret}`)
console.log(`SUPABASE_ANON_KEY=${anonKey}`)
console.log(`SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`)
