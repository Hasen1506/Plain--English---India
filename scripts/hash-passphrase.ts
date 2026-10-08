// Usage: npm run gateway:hash -- "a long passphrase you will remember"
// Prints the value for GATEWAY_PASSPHRASE_HASH. The passphrase itself is never stored.
import { hashPassphrase } from "../gateway/auth.ts";

const pass = process.argv[2];
if (!pass || pass.length < 12) {
  console.error('Give a passphrase of at least 12 characters: npm run gateway:hash -- "correct horse battery staple"');
  process.exit(1);
}
console.log(hashPassphrase(pass));
