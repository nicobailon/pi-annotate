import * as fs from "node:fs";
import * as net from "node:net";

export interface HostConnectionOptions {
  socketPath?: string;
  token?: string;
  label?: string;
}

export interface HostConnectionManagerOptions {
  defaultSocketPath: string;
  defaultTokenPath: string;
  maxSocketBuffer: number;
  createConnection?: (socketPath: string) => net.Socket;
  readToken?: (tokenPath: string) => string;
  onStatus?: (message: string) => void;
  onMessage: (message: unknown) => void | Promise<void>;
  onConnectionLost: () => void | Promise<void>;
}

export interface HostConnectionManager {
  connect: (options?: HostConnectionOptions) => Promise<void>;
  send: (message: object) => void;
}

export function createHostConnectionManager(options: HostConnectionManagerOptions): HostConnectionManager {
  const createConnection = options.createConnection ?? ((socketPath: string) => net.createConnection(socketPath));
  const readToken = options.readToken ?? ((tokenPath: string) => fs.readFileSync(tokenPath, "utf8").trim());

  let browserSocket: net.Socket | null = null;
  let connectedSocketPath: string | null = null;
  let dataBuffer = "";
  let authToken: string | null = null;

  function connect(connectOptions: HostConnectionOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      const socketPath = connectOptions.socketPath || options.defaultSocketPath;
      const label = connectOptions.label || "native host";

      if (browserSocket && !browserSocket.destroyed) {
        if (connectedSocketPath === socketPath) {
          resolve();
          return;
        }
        const previousSocket = browserSocket;
        browserSocket = null;
        authToken = null;
        connectedSocketPath = null;
        dataBuffer = "";
        void options.onConnectionLost();
        previousSocket.destroy();
      }

      try {
        authToken = connectOptions.token || readToken(options.defaultTokenPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reject(new Error(`Failed to read auth token at ${options.defaultTokenPath}: ${message}`, { cause: err }));
        return;
      }

      const socket = createConnection(socketPath);
      browserSocket = socket;

      const isCurrentSocket = () => browserSocket === socket;

      socket.on("connect", () => {
        if (!isCurrentSocket()) return;
        connectedSocketPath = socketPath;
        options.onStatus?.(`Connected to ${label}`);
        send({ type: "AUTH", token: authToken });
        resolve();
      });

      socket.on("data", (data) => {
        if (!isCurrentSocket()) return;
        dataBuffer += data.toString();
        if (dataBuffer.length > options.maxSocketBuffer) {
          options.onStatus?.("Error: Socket buffer overflow");
          socket.destroy();
          dataBuffer = "";
          return;
        }
        const lines = dataBuffer.split("\n");
        dataBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            void options.onMessage(msg);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            options.onStatus?.(`Error: Failed to parse message: ${message}`);
          }
        }
      });

      socket.on("error", (err) => {
        if (!isCurrentSocket()) return;
        options.onStatus?.(`Error: ${err.message}`);
        reject(err);
      });

      socket.on("close", () => {
        if (!isCurrentSocket()) return;
        options.onStatus?.("Disconnected from native host");
        browserSocket = null;
        authToken = null;
        connectedSocketPath = null;
        dataBuffer = "";
        void options.onConnectionLost();
      });
    });
  }

  function send(message: object): void {
    if (browserSocket && !browserSocket.destroyed) {
      browserSocket.write(JSON.stringify(message) + "\n");
    }
  }

  return { connect, send };
}
