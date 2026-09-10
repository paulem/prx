/** Where an app lives on this machine and how to find it */
export type AppLocation = { kind: "path"; command: string } | { kind: "application"; name: string };

export type Injection = "env" | "args";
export type LaunchMode = "attached" | "detached";

/** A built-in description of how to launch one app through the proxy */
export interface Preset {
  name: string;
  app: AppLocation;
  injection: Injection;
  launch: LaunchMode;
  /** Overrides the default probe URL so the probe exercises the host the app needs */
  probeUrl?: string;
}
