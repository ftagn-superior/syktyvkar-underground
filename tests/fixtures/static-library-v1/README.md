# Static library v1 evidence

`invariants.json` pins the approved 22-model library and the independent historical subset retained by this change. The source descriptions in the migration rules contain the old generated vegetation bounds; the target bounds are checked again against generated vertices in the integration test.

`unchanged-triangles.json.gz` contains 1,680 exact records selected from the original immutable `../static-extraction/triangles.json.gz`. These records cover all 66 extracted bus stops, playground objects, and walls, including winding, original colors, and fade membership. Selection matched world-space vertices against the preserved pre-library release with a 1 mm tolerance. The test additionally proves exact record membership and multiplicity in the original stream, and compares the current output with the original records using the existing neutral-AO allowance.

The original extraction fixtures and registry remain unchanged. Trees, bushes, benches, lamps, traffic lights, bollards, and fences have a separate explicit transformation contract; their old geometry is not silently replaced in the historical fixture.

`passages.json.gz` independently records 1,898 original Havok capsule queries at spawn points, routes, and neighboring fence endpoints. The geometry regression checks both newly blocked and newly opened positions. A reviewed local X correction of −0.025 m for `fence-2bf39412d4cec870f4d8` distributes its 0.097 m length increase between its two adjacent passages; all queries retain their original result. The fixture is not regenerated from the replacement geometry.

`passages.json.gz` records 1,898 capsule queries measured before this change: all spawn points, 0.25 m samples on authored routes, and seven transverse points between distinct fence endpoints 0.6–4 m apart. The integration test requires each recorded open or blocked result to remain the same. This includes both narrow openings adjoining the adjusted fence interval. Source release, revision and snapshot digest are embedded in the evidence; the gzip SHA-256 is ac133cebffb0d53bd6ba84bf31c455cfe52ca6355638df5ff90b1687f4c8fbd0.
