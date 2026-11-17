import { createHash } from "node:crypto";

/**
 * The version of the judge contract a judgement was made under: the evidence
 * a judge reads, how its gate matches, and what counts as a verdict.
 * Judgements compare only within one contract version.
 */
export const CONTRACT_VERSION = "3";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidV5(namespace: string, name: string): string {
  if (!UUID.test(namespace)) {
    throw new Error(`judge id "${namespace}" is not a UUID`);
  }
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(name)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The judgement a judge makes of one conversation's evidence: the same judge
 * definition over the same evidence is the same judgement, so a repeat run
 * can be recognised rather than counted twice.
 */
export function judgementId(
  judgeId: string,
  definitionHash: string,
  evidence: string,
  conversationId: string,
): string {
  return uuidV5(
    judgeId,
    `${definitionHash}|${CONTRACT_VERSION}|${evidence}|${conversationId}`,
  );
}

/** Whether a conversation falls inside a judge's sample: stable per judge and conversation. */
export function samplesIn(
  judgeId: string,
  conversationId: string,
  rate: number,
): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const digest = createHash("sha256")
    .update(`${judgeId}:${conversationId}`)
    .digest();
  return digest.readUIntBE(0, 6) / 2 ** 48 < rate;
}
