export const join = (...parts: string[]): string => parts.join("/").replace(/\/+/g, "/");
export const dirname = (p: string): string => p.replace(/\/[^/]*$/, "") || "/";
export const basename = (p: string, ext?: string): string => {
  const b = p.replace(/^.*\//, "");
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
};
export const resolve = join;
export const relative = (from: string, to: string): string => (to.startsWith(from + "/") ? to.slice(from.length + 1) : to);
