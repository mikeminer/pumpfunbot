import { Keypair } from "@solana/web3.js";
import { readFileSync } from "fs";
import { PATHS } from "./config.js";
// Loads the dedicated keypair. Secret bytes are never logged or returned outside this module's signer.
let kp: Keypair | null = null;
export function wallet(): Keypair {
  if (!kp) kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(PATHS.wallet, "utf8"))));
  return kp;
}
