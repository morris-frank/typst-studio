import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { compileMarkdown, compileTyp } from "./compiler";
import type { TypstPluginSettings } from "./settings";

const USAGE = `usage: typst-studio <file.md|file.typ> [-o out.pdf]

Compiles like the Obsidian plugin. Settings come from the enclosing vault's
.obsidian/plugins/typst-studio/data.json when there is one.`;

/** The nearest ancestor holding `.obsidian/`, else the file's own directory. */
function vaultRoot(file: string): string {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".obsidian"))) return dir;
    if (dir === path.dirname(dir)) return path.dirname(file);
  }
}

/** Flat `key: value` frontmatter, enough for title/author/date and friends. */
function frontmatter(md: string): Record<string, string> {
  const block = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const fm: Record<string, string> = {};
  for (const m of block.matchAll(/^(\w+):\s*(.+)$/gm))
    fm[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  return fm;
}

async function main(argv: string[]): Promise<void> {
  const o = argv.indexOf("-o");
  const out = o >= 0 ? argv.splice(o, 2)[1] : undefined;
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    console.error(USAGE);
    process.exit(2);
  }
  const source = path.resolve(argv[0]);
  const vault = vaultRoot(source);
  const dataJson = path.join(vault, ".obsidian/plugins/typst-studio/data.json");
  // Defaults mirror DEFAULT_SETTINGS; settings.ts imports obsidian at runtime.
  const settings: TypstPluginSettings = {
    typstPath: "typst",
    pandocPath: "pandoc",
    mermaidPath: "mmdc",
    chromePath: "",
    mermaidConfig: "",
    templatePath: "",
    templateFunction: "",
    templateArgs: "",
    defaultAuthor: "",
    outputDir: "",
    openAfterCompile: false,
    registerTypView: false,
    ...(existsSync(dataJson) ? JSON.parse(readFileSync(dataJson, "utf8")) : {}),
  };
  const ext = path.extname(source);
  const pdf = path.resolve(out ?? source.slice(0, -ext.length) + ".pdf");

  if (ext === ".typ") {
    await compileTyp(source, pdf, settings);
  } else if (ext === ".md") {
    const md = readFileSync(source, "utf8");
    const { mermaidFailures } = await compileMarkdown(
      source,
      md,
      frontmatter(md),
      pdf,
      settings,
      path.basename(vault),
      vault,
    );
    for (const f of mermaidFailures)
      console.error(`mermaid diagram left as code: ${f}`);
  } else {
    throw new Error(`not a .md or .typ file: ${argv[0]}`);
  }
  console.log(pdf);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
