import type { EndpointType } from "../config.ts";

/** Where an app lives on this machine and how to find it */
export type AppLocation = { kind: "path"; command: string } | { kind: "application"; name: string };

export type Injection = "env" | "args";
export type LaunchMode = "attached" | "detached";

/** A built-in description of how to launch one app through the proxy */
export interface Preset {
  name: string;
  app: AppLocation;
  injection: Injection;
  /** The endpoint types the app can use, most preferred first */
  endpoints: EndpointType[];
  launch: LaunchMode;
  /** Overrides the default probe URL so the probe exercises the host the app needs */
  probeUrl?: string;
  /** Why a launch must be refused while the app is already running, for apps that ignore injection then */
  refuseWhenRunning?: string;
}
