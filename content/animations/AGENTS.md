# Animation authoring

Read [Add an animation](../../docs/add-animation.md) before changing this collection.

- `catalog.json` is the engine-independent metadata source. Each ID owns one
  `apps/client/src/rendering/avatars/clips/<id>.ts` module.
- Use `pnpm animations:add -- --id ... --label ... --category ... --mode upperBody|fullBody`.
  Edit the resulting pose, then `pnpm animations:sync` and `pnpm animations:check`.
- Commit the manifest, clip and both generated indexes together. Never edit the indexes manually.
- Keep existing IDs stable. All skins, including the seated bear, must work with reduced motion.
  No UI/server registration or database migration is needed for an ordinary procedural clip.
- `pnpm check` rejects a stale or invalid catalog. Run the guide's focused tests and browser checks;
  do not interpret database-dependent tests skipped without `SU_TEST_DATABASE_URL` as passes.
- Catalog compatibility is exact and generated from metadata and clip source. Rebuild/release client
  and server together; older or missing catalog fingerprints are rejected with `VERSION_MISMATCH`.
