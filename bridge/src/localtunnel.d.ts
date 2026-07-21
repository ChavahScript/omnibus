declare module "localtunnel" {
  export type Tunnel = {
    url: string;
    close(): void;
    /**
     * localtunnel exposes an EventEmitter-shaped client. The package does not
     * publish TypeScript definitions, but its `error` and `close` events are
     * essential for the bridge's supervised recovery lifecycle.
     */
    on(event: "error", listener: (error: Error) => void): Tunnel;
    on(event: "close", listener: () => void): Tunnel;
    off(event: "error", listener: (error: Error) => void): Tunnel;
    off(event: "close", listener: () => void): Tunnel;
  };

  export type LocaltunnelOptions = {
    port: number;
    subdomain?: string;
  };

  export default function localtunnel(options: LocaltunnelOptions): Promise<Tunnel>;
}
