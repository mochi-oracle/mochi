// The live client validates service responses with Zod 4 schemas from @mochi/protocol. When Zod builds an object
// schema it probes `new Function("")` to decide whether it may compile fast parsers. The site's CSP has no
// 'unsafe-eval', so the probe is blocked and reported as a script-src violation even though Zod catches the error.
// Jitless mode skips the probe and parses without generated code. Zod reads this setting when it builds each schema,
// so every entry that loads the live client imports this module first, before any schema module is evaluated.
import { config } from 'zod';

config({ jitless: true });
