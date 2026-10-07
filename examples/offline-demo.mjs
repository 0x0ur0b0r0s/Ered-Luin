import { readFile } from "node:fs/promises";
import { reviewExamplePacket } from "./non-production-policy.mjs";

const fixtureUrl = new URL("./mock-data/intelligence-packet.synthetic.json", import.meta.url);
const packet = JSON.parse(await readFile(fixtureUrl, "utf8"));

console.log(JSON.stringify({
  packetId: packet.id,
  classification: packet.synthetic ? "synthetic" : "unspecified",
  evidenceCount: packet.evidence.length,
  exampleReview: reviewExamplePacket(packet),
}, null, 2));