/**
 * A tiny documentation example. This has no transaction or execution hooks
 * and is not the production policy implementation.
 */
export function reviewExamplePacket(packet) {
  if (!packet || !Array.isArray(packet.evidence) || packet.evidence.length === 0) {
    return "REVIEW_EXAMPLE";
  }

  if (packet.evidence.some((item) => item.freshness !== "fresh")) {
    return "REVIEW_EXAMPLE";
  }

  return "DEMO_ONLY";
}