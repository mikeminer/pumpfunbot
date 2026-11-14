// Generates a NEW dedicated keypair. Never prints secret material.
import { Keypair } from "@solana/web3.js";
import { existsSync, writeFileSync, chmodSync } from "fs";
const path = new URL("../secrets/wallet.json", import.meta.url).pathname;
if (existsSync(path)) { console.error("wallet.json already exists; refusing to overwrite"); process.exit(1); }
const kp = Keypair.generate();
writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
chmodSync(path, 0o600);
console.log("Public address:", kp.publicKey.toBase58());
