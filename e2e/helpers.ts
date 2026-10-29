import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BIN = ['--conditions=source', '--import', 'tsx', 'packages/cli/src/bin.ts'];

/** Runs `ibk` as a real subprocess. */
export function ibk(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...BIN, ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Starts `ibk serve --port 0` and resolves with its base URL once it is listening. */
export function startServer(env: Record<string, string> = {}): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...BIN, 'serve', '--port', '0'], { cwd: ROOT, env: { ...process.env, ...env } });
    let log = '';
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 30_000);
    child.stderr.on('data', (d) => {
      log += d;
      const m = /GraphQL\s+(http:\/\/localhost:\d+)\/graphql/.exec(log);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve({ url: m[1], child });
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}:\n${log}`)));
  });
}
