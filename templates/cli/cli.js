#!/usr/bin/env node
import { pathToFileURL } from "node:url";
export const greet = (args) => args.includes("--help") ? "Usage: hello [name]" : `Hello, ${args.join(" ") || "world"}!`;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(greet(process.argv.slice(2)));
