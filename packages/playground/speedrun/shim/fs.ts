// node:fs for drive.ts off Node: an in-memory file map. Checkpoint saves land
// here too, and `onWrite` is how the host sees each frame as it is saved.
export const vfs = new Map<string, string>();
export const hooks: { onWrite?: (path: string, text: string) => void } = {};

export const readFileSync = (path: string, _encoding?: string): string => {
  const text = vfs.get(path);
  if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  return text;
};
export const writeFileSync = (path: string, text: string): void => {
  vfs.set(path, text);
};
export const renameSync = (from: string, to: string): void => {
  const text = readFileSync(from);
  vfs.delete(from);
  vfs.set(to, text);
  hooks.onWrite?.(to, text);
};
export const existsSync = (path: string): boolean => vfs.has(path);
