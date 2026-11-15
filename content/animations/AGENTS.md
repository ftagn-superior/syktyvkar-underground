# Animation authoring

Read [Add an animation](../../docs/add-animation.md) before changing this collection.

- `catalog.json` is the engine-independent metadata source. Each ID owns one
  `apps/client/src/rendering/avatars/clips/<id>.ts` module.
- Use `pnpm animations:add -- --id ... --label ... --category ... --mode upperBody|fullBody`.
  Edit the resulting pose, then `pnpm animations:sync` and `pnpm animations:check`.
- Commit the manifest, clip and both generated indexes together. Never edit the indexes manually.
- Keep existing IDs stable. Declare skin support explicitly for v2. Wheelchair adaptations need a real seated sampler; unavailable movements need an explanation in metadata. All supported variants must work with reduced motion.
  No UI/server registration or database migration is needed for an ordinary procedural clip.
- `pnpm check` rejects a stale or invalid catalog. Run the guide's focused tests and browser checks;
  do not interpret database-dependent tests skipped without `SU_TEST_DATABASE_URL` as passes.
- Catalog compatibility is exact and generated from metadata and clip source. Rebuild/release client
  and server together; older or missing catalog fingerprints are rejected with `VERSION_MISMATCH`.

- For elbows/knees/root poses pass `--rig humanoid-v2`; ground poses also require `--support ground`, `--seated variant|unavailable` with `--seated-message`, and `--reduced-motion static` with `--reduced-motion-label`. The full example is in the guide.
- Do not ship the `rig-*` technical fixture IDs. S-34 owns the final seven user clips; S-53 only extends the pipeline.
