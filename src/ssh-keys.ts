import type { SystemAdapter } from "./system.ts";

export const PUBLIC_KEY_SUFFIX = ".pub";

const OPENSSH_HEADER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const OPENSSH_FOOTER = "-----END";
const OPENSSH_MAGIC = "openssh-key-v1\0";
const NO_CIPHER = "none";
const LEGACY_ENCRYPTED = "Proc-Type: 4,ENCRYPTED";

/** Whether ssh-agent holds an identity; unknown without the public half to recognise it by */
export type AgentPresence = "loaded" | "missing" | "unknown";

/** What decides whether the tunnel can authenticate with an identity, see ADR-0004 */
export interface IdentityStatus {
  /** Whether the key needs a passphrase, which the tunnel never has anyone to ask for */
  encrypted: boolean;
  agent: AgentPresence;
}

/**
 * Reads an identity file and ssh-agent to tell whether the tunnel could use the key. An
 * encrypted key is unusable until ssh-agent holds it, since the tunnel runs in batch mode
 */
export async function readIdentityStatus(
  system: SystemAdapter,
  identityFile: string,
): Promise<IdentityStatus> {
  const [privateKey, publicKey, agentKeys] = await Promise.all([
    system.readTextFile(identityFile),
    system.readTextFile(`${identityFile}${PUBLIC_KEY_SUFFIX}`),
    system.sshAgentKeys(),
  ]);
  return identityStatus(privateKey, publicKey, agentKeys);
}

/** The same verdict from text already in hand, so a list of keys asks ssh-agent only once */
export function identityStatus(
  privateKey: string | undefined,
  publicKey: string | undefined,
  agentKeys: string[],
): IdentityStatus {
  return { encrypted: isEncrypted(privateKey), agent: agentPresence(publicKey, agentKeys) };
}

/** Whether the tunnel would fail on this identity until someone adds it to ssh-agent */
export function needsAgent(status: IdentityStatus): boolean {
  return status.encrypted && status.agent === "missing";
}

/** What to run to unlock an identity for the tunnel, storing the passphrase in the Keychain */
export function addToAgentCommand(keyPath: string): string {
  return `ssh-add --apple-use-keychain ${keyPath}`;
}

function agentPresence(publicKey: string | undefined, agentKeys: string[]): AgentPresence {
  const blob = keyBlob(publicKey);
  if (blob === undefined) {
    return "unknown";
  }
  return agentKeys.some((key) => keyBlob(key) === blob) ? "loaded" : "missing";
}

// The base64 body of a public key line, which identifies the key whatever comment follows it
function keyBlob(publicKey: string | undefined): string | undefined {
  return publicKey?.trim().split(/\s+/)[1];
}

function isEncrypted(privateKey: string | undefined): boolean {
  if (privateKey === undefined) {
    return false;
  }
  if (privateKey.includes(LEGACY_ENCRYPTED)) {
    return true;
  }
  const cipher = opensshCipher(privateKey);
  return cipher !== undefined && cipher !== NO_CIPHER;
}

// An OpenSSH private key names its cipher right after the magic, as a length-prefixed string;
// "none" is what an unencrypted key carries there
function opensshCipher(privateKey: string): string | undefined {
  const start = privateKey.indexOf(OPENSSH_HEADER);
  if (start === -1) {
    return undefined;
  }
  const body = privateKey.slice(start + OPENSSH_HEADER.length).split(OPENSSH_FOOTER)[0] ?? "";
  const bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
  const offset = OPENSSH_MAGIC.length;
  if (bytes.toString("latin1", 0, offset) !== OPENSSH_MAGIC || bytes.length < offset + 4) {
    return undefined;
  }
  const length = bytes.readUInt32BE(offset);
  if (bytes.length < offset + 4 + length) {
    return undefined;
  }
  return bytes.toString("utf8", offset + 4, offset + 4 + length);
}
