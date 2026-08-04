// Barrel entrypoint — this is what drizzle.config.ts points `schema` at, and
// what server/utils/db.ts imports to run migrations. Table modules are
// grouped by their real FK dependency graph, not by schema.sql's original
// chronological "phase" ordering; see the comment at the top of core.ts for
// why auctions/artifact_*/auction_details specifically had to stay together.
export * from './access'
export * from './lawyers'
export * from './core'
export * from './translations'
export * from './observations'
export * from './ops'
export * from './geo'
