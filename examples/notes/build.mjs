// The example app's "build": dist/index.html from src/index.html (a real app would run its bundler here).
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("dist", { recursive: true });
copyFileSync("src/index.html", "dist/index.html");
