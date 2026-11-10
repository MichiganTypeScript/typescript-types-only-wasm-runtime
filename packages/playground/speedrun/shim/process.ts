// drive.ts's view of `process` off Node. stdout/stderr go to `log`, which the
// worker forwards to the page.
export const log: { write: (stream: "stdout" | "stderr", text: string) => void } = {
  write: (_stream, text) => console.log(text),
};
export const process = {
  env: {} as Record<string, string | undefined>,
  argv: ["node", "drive"],
  pid: 1,
  exitCode: 0 as number | undefined,
  exit: (code?: number) => {
    throw new Error(`process.exit(${code})`);
  },
  stdout: { write: (text: string) => (log.write("stdout", text), true) },
  stderr: { write: (text: string) => (log.write("stderr", text), true) },
};
