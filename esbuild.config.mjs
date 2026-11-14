import esbuild from "esbuild";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";
const harness = process.argv.includes("--harness");

const common = { bundle: true, target: "es2018", logLevel: "info", sourcemap: prod ? false : "inline", treeShaking: true };

if (harness) {
  await esbuild.build({ ...common, entryPoints: ["harness/mock.ts"], outfile: "harness/harness.js", format: "iife" });
} else {
  const ctx = await esbuild.context({
    ...common,
    entryPoints: ["src/main.ts"],
    outfile: "main.js",
    format: "cjs",
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
    minify: prod,
  });
  if (prod) { await ctx.rebuild(); await ctx.dispose(); } else { await ctx.watch(); }
}
