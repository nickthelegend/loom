// A stand-in for `opencode serve --port N`: the fake server, with a turn that never ends.
import { fakeOpenCode } from "./opencode-fake.js";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
await fakeOpenCode({ port, stuck: true });
setInterval(() => {}, 1 << 30);
