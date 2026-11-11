declare module 'gltf-validator' {
  export function validateBytes(
    data: Uint8Array,
    options?: { uri?: string; writeTimestamp?: boolean },
  ): Promise<{
    issues: {
      numErrors: number;
      numWarnings: number;
      messages: Array<{ code: string; message: string; pointer?: string }>;
    };
  }>;
}
