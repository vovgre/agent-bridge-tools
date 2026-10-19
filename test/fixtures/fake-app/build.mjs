// The fake app's "build": dist/index.html from src/index.html.
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("dist", { recursive: true });
copyFileSync("src/index.html", "dist/index.html");
