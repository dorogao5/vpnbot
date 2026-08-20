import { createHash } from "node:crypto";
import { Client } from "ssh2";

export interface SshCommandOptions {
  host: string;
  port: number;
  username: string;
  privateKey: string | Buffer;
  hostFingerprint: string;
  command: string;
  input?: Buffer;
  timeoutMs?: number;
}

export function keyFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export function runSshCommand(options: SshCommandOptions): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise<Buffer>((resolve, reject) => {
    const connection = new Client();
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        connection.end();
        reject(new Error(`Тайм-аут подключения к ${options.host}`));
      }
    }, timeoutMs);

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      connection.end();
      callback();
    };

    connection.on("ready", () => {
      connection.exec(options.command, (error, stream) => {
        if (error) {
          finish(() => reject(error));
          return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
        stream.stderr.on("data", (chunk: Buffer) =>
          stderr.push(Buffer.from(chunk))
        );
        if (options.input) {
          stream.write(options.input);
        }
        stream.end();
        stream.on("close", (code: number | undefined) => {
          const errorText = Buffer.concat(stderr).toString("utf8").trim();
          if (code === 0) {
            finish(() => resolve(Buffer.concat(stdout)));
          } else {
            finish(() =>
              reject(
                new Error(
                  errorText || `Команда завершилась с кодом ${code ?? "?"}`
                )
              )
            );
          }
        });
      });
    });
    connection.on("error", (error) => finish(() => reject(error)));
    connection.connect({
      host: options.host,
      port: options.port,
      username: options.username,
      privateKey: options.privateKey,
      readyTimeout: 20_000,
      keepaliveInterval: 5_000,
      hostVerifier: (key: Buffer) =>
        keyFingerprint(key) === options.hostFingerprint,
    });
  });
}

export interface SshConnectOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string | Buffer;
  timeoutMs?: number;
}

export function runSshShell(
  options: SshConnectOptions,
  command: string
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? 600_000;
  return new Promise<Buffer>((resolve, reject) => {
    const connection = new Client();
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        connection.end();
        reject(new Error(`Тайм-аут операции на ${options.host}`));
      }
    }, timeoutMs);

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      connection.end();
      callback();
    };

    connection.on("ready", () => {
      connection.exec(command, { pty: false }, (error, stream) => {
        if (error) {
          finish(() => reject(error));
          return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
        stream.stderr.on("data", (chunk: Buffer) =>
          stderr.push(Buffer.from(chunk))
        );
        stream.on("close", (code: number | undefined) => {
          const out = Buffer.concat(stdout).toString("utf8").trim();
          const err = Buffer.concat(stderr).toString("utf8").trim();
          if (code === 0) {
            finish(() => resolve(Buffer.concat(stdout)));
          } else {
            finish(() =>
              reject(
                new Error(err || out || `Команда завершилась с кодом ${code ?? "?"}`)
              )
            );
          }
        });
      });
    });
    connection.on("error", (error) => finish(() => reject(error)));
    connection.connect({
      host: options.host,
      port: options.port,
      username: options.username,
      ...(options.password ? { password: options.password } : {}),
      ...(options.privateKey ? { privateKey: options.privateKey } : {}),
      readyTimeout: 20_000,
      keepaliveInterval: 10_000,
      tryKeyboard: Boolean(options.password),
    });
  });
}
