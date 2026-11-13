export type ElementLookup = <T extends HTMLElement>(id: string) => T;

/** The application owns a fixed DOM shell; resolve its elements once per lifetime. */
export function createElementLookup(root: Document): ElementLookup {
  const elements = new Map<string, HTMLElement>();
  return <T extends HTMLElement>(id: string): T => {
    let element = elements.get(id);
    if (!element) {
      element = root.getElementById(id) ?? undefined;
      if (!element) throw new Error(`Missing UI: ${id}`);
      elements.set(id, element);
    }
    return element as T;
  };
}
