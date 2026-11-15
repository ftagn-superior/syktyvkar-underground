# Avatar animation changes

For a new procedural clip follow [Add an animation](../../../../../docs/add-animation.md).
The `animations:add`, `animations:sync`, and `animations:check` commands own registration.

Clips are pure pose samplers in `clips/`. Assign all masked channels on every call, avoid scene,
DOM, time and physics side effects, and preserve the reduced-motion and seated-rig policies.
Do not change locomotion or server handlers merely to add a catalog item. A new joint, imported
skeleton or gameplay action needs a separate contract. Test all catalog entries against all skins.
