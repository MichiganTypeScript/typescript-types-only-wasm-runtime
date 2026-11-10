export const fileURLToPath = (url: string | URL): string => String(url).replace(/^file:\/\//, "");
