import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { TypstPluginSettings } from "./settings";
import BUNDLED_TEMPLATE from "./template.typ";

export class CompileError extends Error {}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn a process, optionally piping `input` to stdin, and collect output. */
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      reject(
        new CompileError(
          `Failed to run \`${cmd}\`: ${err.message}. Is it installed and is the path in settings correct?`,
        ),
      );
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** Deepest directory that is an ancestor of every given absolute path. */
export function commonAncestor(paths: string[]): string {
  const dirs = paths.map((p) => path.dirname(path.resolve(p)).split(path.sep));
  const first = dirs[0];
  const out: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (dirs.every((d) => d[i] === seg)) out.push(seg);
    else break;
  }
  const joined = out.join(path.sep);
  return joined === "" ? path.sep : joined;
}

/** Resolve a template path (file or directory) to a concrete `.typ` file. */
export async function resolveTemplateFile(
  templatePath: string,
): Promise<string> {
  const abs = path.resolve(templatePath);
  const stat = await fs.stat(abs).catch(() => {
    throw new CompileError(`Template path does not exist: ${abs}`);
  });
  if (stat.isFile()) return abs;
  // Directory: prefer assets/<fn>.typ, else the first .typ we find.
  const candidates: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 2) return;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name.endsWith(".typ")) candidates.push(full);
    }
  };
  await walk(abs, 0);
  if (candidates.length === 0)
    throw new CompileError(`No .typ template found under: ${abs}`);
  // Prefer one whose basename matches the directory name (e.g. my-template/my-template.typ).
  const dirName = path.basename(abs);
  return (
    candidates.find((c) => path.basename(c, ".typ") === dirName) ??
    candidates.sort((a, b) => a.length - b.length)[0]
  );
}

/**
 * A root-relative Typst import path (starting with `/`) for `target`, given
 * that Typst is invoked with `--root root`. Handles the case where the target
 * lives outside the compiled file's own directory.
 */
function rootRelativeImport(root: string, target: string): string {
  const rel = path.relative(root, path.resolve(target));
  return "/" + rel.split(path.sep).join("/");
}

function typstStringLiteral(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** Escape a value for use as Typst content inside `[...]`. */
function typstContent(value: string): string {
  return value.replace(/([\\#\[\]])/g, "\\$1");
}

/** Build the `.with(...)` argument string from frontmatter + user settings. */
function buildTemplateArgs(
  frontmatter: Record<string, unknown>,
  extraArgs: string,
  defaultAuthor: string,
): string {
  const parts: string[] = [];
  const fm = frontmatter ?? {};

  const str = (v: unknown) => (v == null ? undefined : String(v));
  const title = str(fm.title);
  const subtitle = str(fm.subtitle);
  const eyebrow = str(fm.eyebrow ?? fm.category);

  if (title) parts.push(`title: [${typstContent(title)}]`);
  if (subtitle) parts.push(`subtitle: ${typstStringLiteral(subtitle)}`);
  if (eyebrow) parts.push(`eyebrow: ${typstStringLiteral(eyebrow)}`);

  const meta: Array<[string, string]> = [];
  const author = fm.author ?? defaultAuthor;
  if (author) meta.push(["Author", String(author)]);
  if (fm.date) meta.push(["Date", String(fm.date)]);
  if (fm.version) meta.push(["Version", String(fm.version)]);
  if (meta.length) {
    const rows = meta
      .map(([k, v]) => `(${typstStringLiteral(k)}, ${typstStringLiteral(v)})`)
      .join(", ");
    // Trailing comma is required: `(("Date", "x"))` is not a nested array in
    // Typst, it collapses to `("Date", "x")` and the template reads characters.
    parts.push(`meta: (${rows},)`);
  }

  if (extraArgs.trim()) parts.push(extraArgs.trim().replace(/,\s*$/, ""));
  return parts.join(",\n  ");
}

/** Escape a value for use as Markdown link text. */
function markdownLinkText(value: string): string {
  return value.replace(/([\\\[\]])/g, "\\$1");
}

/**
 * Rewrite Obsidian wiki links (`[[note]]`, `[[note|alias]]`, `[[note#heading]]`,
 * `![[note]]`) into Markdown links on an `obsidian://open` URL, so a reference
 * in the PDF is clickable and lands on the note it cites. Without this, pandoc
 * escapes the brackets and the reader gets `\[\[people/Julia Jehn\]\]`.
 */
export function rewriteWikiLinks(markdown: string, vaultName: string): string {
  return markdown.replace(
    /!?\[\[([^\]|#\n]+?)(?:#([^\]|\n]*))?(?:\|([^\]\n]*))?\]\]/g,
    (_whole, target: string, anchor: string | undefined, alias) => {
      const file = target.trim().replace(/\.md$/i, "");
      const heading = anchor?.trim();
      const label =
        (alias as string | undefined)?.trim() || file.split("/").pop() || file;
      const query =
        `vault=${encodeURIComponent(vaultName)}` +
        `&file=${encodeURIComponent(file + (heading ? `#${heading}` : ""))}`;
      return `[${markdownLinkText(label)}](obsidian://open?${query})`;
    },
  );
}

/**
 * Turn a code span naming a vault file (`` `meetings/2026-09-28 Sync.md` ``)
 * into an `obsidian://open` link, so the PDF points into the vault rather than
 * printing a path that only means something on this machine.
 */
export function linkVaultPaths(
  markdown: string,
  vaultName: string,
  vaultRoot: string,
): string {
  return markdown.replace(
    /(?<![`\[])`([^`\n]+\.[A-Za-z0-9]+)`(?!`)/g,
    (whole, p: string) => {
      if (!existsSync(path.join(vaultRoot, p))) return whole;
      const file = p.replace(/\.md$/i, "");
      const query = `vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file)}`;
      return `[${whole}](obsidian://open?${query})`;
    },
  );
}

/**
 * Obsidian's custom task states (`- [?]`, `- [!]`, `- [i]`, …) are not task
 * items to pandoc and would print as `[?]`. Emit a raw `#task-mark` instead,
 * which `wrapTaskLists` groups with ordinary task items.
 */
export function rewriteTaskStates(markdown: string): string {
  return markdown.replace(
    /^([ \t]*[-*+] )\[([^ xX\]])\] /gm,
    (_whole, head: string, c: string) =>
      `${head}\`#task-mark(${typstStringLiteral(c)})\`{=typst} `,
  );
}

const CALLOUT_HEAD = /^([ \t]*)>[ \t]*\[!([A-Za-z][\w-]*)\][+-]?[ \t]*(.*)$/;

/**
 * Rewrite Obsidian callouts (`> [!warning] Title`) into a raw-Typst
 * `#admonition(...)` wrapper around the still-Markdown body, so the body keeps
 * its bold, links and lists while the box itself is branded. pandoc passes
 * ```{=typst}``` fences through verbatim.
 */
export function rewriteCallouts(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = CALLOUT_HEAD.exec(lines[i]);
    if (!head) {
      out.push(lines[i]);
      continue;
    }
    // The indent is kept on every emitted line so a callout nested inside a
    // list item stays inside it.
    const [, indent, kind, title] = head;
    const body: string[] = [];
    while (
      i + 1 < lines.length &&
      new RegExp(`^${indent}>`).test(lines[i + 1])
    ) {
      body.push(lines[++i].slice(indent.length).replace(/^>[ \t]?/, ""));
    }
    const titleArg = title.trim()
      ? `, title: [${typstContent(title.trim())}]`
      : "";
    out.push(
      ...[
        "```{=typst}",
        `#admonition(${typstStringLiteral(kind.toLowerCase())}${titleArg})[`,
        "```",
        "",
        ...body,
        "",
        "```{=typst}",
        "]",
        "```",
        "",
      ].map((l) => (l ? indent + l : l)),
    );
  }
  return out.join("\n");
}

// pandoc emits the task-list checkbox either as the literal glyph or, since
// 3.11, as a Typst unicode escape (`\u{2610}` / `\u{2612}`). Match both, or a
// pandoc upgrade silently turns every task list back into dashes and boxes.
const TASK_MARK = String.raw`(?:[\u2610\u2612]|\\u\{261[02]\}|#task-mark\()`;
const TASK_BLOCK = new RegExp(
  String.raw`^(?:[ \t]*- ${TASK_MARK}[^\n]*\n(?:[ \t]+\S[^\n]*\n)*)+`,
  "gm",
);

// A custom task state drawn as a checkbox holding its glyph (`?`, `!`, `i`…).
const TASK_MARK_DEF =
  "#let task-mark(c) = box(width: 0.8em, height: 0.8em, baseline: 0.1em, " +
  "radius: 1pt, stroke: 1.2pt + luma(110), inset: 0pt, align(center + horizon, " +
  'text(size: 0.6em, weight: 700)[#if c == "-" { sym.dash.en } else { c }])) + h(0.4em)';

/**
 * Route pandoc's non-default enum numbering (`A.`, `i.`, …) through the
 * template's `styled-enum-numbering`, so a lettered list keeps the accent
 * marker that plain `1.` lists get from the template's own `set enum`.
 */
export function styleEnumNumbering(typstSource: string): string {
  return typstSource.replace(
    /(#set enum\(numbering: )("(?:[^"\\]|\\.)*")/g,
    (_whole, head: string, pattern: string) =>
      `${head}styled-enum-numbering(${pattern})`,
  );
}

/**
 * Wrap pandoc's task-list output in `#task-list[...]`. pandoc renders
 * `- [ ]` as a plain bullet whose body starts with `☐`, which would print as
 * a dash followed by a box; the template's `task-list` drops the dash and
 * turns the glyph into a branded checkbox.
 */
export function wrapTaskLists(typstSource: string): string {
  return typstSource.replace(TASK_BLOCK, (block) => `#task-list[\n${block}]\n`);
}

/**
 * Default mermaid config: the neutral theme, Typst-safe labels and tight
 * spacing. The "Mermaid config" setting is merged over it (see mermaidConfig).
 *
 * `htmlLabels: false` is not cosmetic — mermaid otherwise puts every node label
 * in an SVG `<foreignObject>`, which Typst cannot render, and the diagram
 * arrives in the PDF as a set of empty boxes.
 */
const MERMAID_CONFIG: Record<string, unknown> = {
  htmlLabels: false,
  theme: "neutral",
  // Tighter spacing is not cosmetic either: it lifts the ratio of label size
  // to total diagram width, which is what decides whether the text is still
  // readable once the SVG is scaled down to the page measure.
  flowchart: {
    htmlLabels: false,
    curve: "basis",
    useMaxWidth: true,
    nodeSpacing: 30,
    rankSpacing: 45,
  },
  sequence: { useMaxWidth: true },
  gantt: { useMaxWidth: true },
};

/**
 * The default config with the user's JSON merged over it (one level deep, so
 * `themeVariables` or `flowchart` keys add to the defaults rather than
 * replacing them). `htmlLabels` is forced off afterwards: it is not a style
 * choice but what keeps labels renderable by Typst.
 */
export function mermaidConfig(userJson: string): Record<string, unknown> {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  let user: unknown = {};
  if (userJson.trim()) {
    try {
      user = JSON.parse(userJson);
    } catch (e) {
      throw new CompileError(
        `Mermaid config is not valid JSON: ${(e as Error).message}`,
      );
    }
  }
  const out: Record<string, unknown> = { ...MERMAID_CONFIG };
  if (isObj(user))
    for (const [k, v] of Object.entries(user))
      out[k] = isObj(v) && isObj(out[k]) ? { ...out[k], ...v } : v;
  out.htmlLabels = false;
  if (isObj(out.flowchart))
    out.flowchart = { ...out.flowchart, htmlLabels: false };
  return out;
}

const MERMAID_FENCE =
  /^([ \t]*)```+[ \t]*mermaid[ \t]*\n([\s\S]*?)^\1```+[ \t]*$/gm;

export interface MermaidResult {
  /** The markdown with each rendered fence replaced by a raw-Typst image. */
  markdown: string;
  /** Temporary files to delete once the compile is done. */
  artifacts: string[];
  /** Fences that could not be rendered, left in place as code blocks. */
  failures: string[];
}

/**
 * Render every ```mermaid fence to an SVG beside the source and replace it
 * with a raw-Typst `#image(...)`. The SVGs must live under the compile root
 * for Typst to read them, which is why they land next to the note rather than
 * in a temp directory; they are cleaned up with the wrapper.
 *
 * A missing or failing `mmdc` is not fatal: that fence stays a code block and
 * the caller is told, because a diagram that did not render is worth a warning
 * and not worth losing the whole export over.
 */
export async function renderMermaid(
  markdown: string,
  sourceAbs: string,
  settings: TypstPluginSettings,
): Promise<MermaidResult> {
  const artifacts: string[] = [];
  const failures: string[] = [];
  const blocks: Array<{ whole: string; indent: string; code: string }> = [];
  for (const m of markdown.matchAll(MERMAID_FENCE))
    blocks.push({ whole: m[0], indent: m[1], code: m[2] });
  if (blocks.length === 0 || !settings.mermaidPath.trim())
    return { markdown, artifacts, failures };

  const dir = path.dirname(sourceAbs);
  const stem = `.${path.basename(sourceAbs, path.extname(sourceAbs))}.mermaid`;
  const cfgFile = path.join(dir, `${stem}.config.json`);
  await fs.writeFile(
    cfgFile,
    JSON.stringify(mermaidConfig(settings.mermaidConfig)),
    "utf8",
  );
  artifacts.push(cfgFile);

  let ppFile: string | null = null;
  if (settings.chromePath.trim()) {
    ppFile = path.join(dir, `${stem}.puppeteer.json`);
    await fs.writeFile(
      ppFile,
      JSON.stringify({ executablePath: settings.chromePath.trim() }),
      "utf8",
    );
    artifacts.push(ppFile);
  }

  let out = markdown;
  for (let i = 0; i < blocks.length; i++) {
    const { whole, indent, code } = blocks[i];
    const mmd = path.join(dir, `${stem}-${i + 1}.mmd`);
    const svg = path.join(dir, `${stem}-${i + 1}.svg`);
    await fs.writeFile(mmd, code, "utf8");
    artifacts.push(mmd);
    const args = ["-i", mmd, "-o", svg, "-c", cfgFile, "-b", "transparent"];
    if (ppFile) args.push("-p", ppFile);
    const res = await run(settings.mermaidPath, args, { cwd: dir }).catch(
      (err: Error) => ({ code: 1, stdout: "", stderr: err.message }),
    );
    if (res.code !== 0 || !(await fs.stat(svg).catch(() => null))) {
      failures.push(res.stderr.trim().split("\n").pop() || "mmdc failed");
      continue;
    }
    artifacts.push(svg);
    const image = [
      "```{=typst}",
      typstFigure(path.basename(svg), await svgAspect(svg)),
      "```",
    ]
      .map((l) => indent + l)
      .join("\n");
    out = out.replace(whole, image);
  }
  return { markdown: out, artifacts, failures };
}

/** Width-to-height ratio from an SVG's viewBox, or 1 if it has none. */
async function svgAspect(svgFile: string): Promise<number> {
  const head = (await fs.readFile(svgFile, "utf8")).slice(0, 2000);
  const box = /viewBox="([\d.\-]+)\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)"/.exec(
    head,
  );
  if (!box) return 1;
  const [w, h] = [Number(box[3]), Number(box[4])];
  return h > 0 ? w / h : 1;
}

/**
 * A wide diagram scaled to the text measure ends up with unreadable labels, so
 * one past 1.9:1 is allowed to pad out into the page margins. Anything squarer
 * stays inside the measure, where it belongs.
 */
function typstFigure(basename: string, aspect: number): string {
  const img = `image(${typstStringLiteral(basename)}`;
  return aspect >= 1.9
    ? `#pad(x: -0.75in, figure(${img}, width: 100% + 1.5in)))`
    : `#figure(${img}, width: 100%))`;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Rewrite bare imports of the configured template to a root-relative absolute
 * path pointing at its real location, so a `.typ` file can `#import
 * "my-template.typ"` from anywhere without the template sitting next to
 * it. Only imports whose basename matches the resolved template file are
 * touched; every other import is left alone. The template's own asset paths
 * (logo, patterns) resolve relative to its real location, so they keep working.
 */
export function rewriteTemplateImports(
  source: string,
  templateFile: string,
  root: string,
): { source: string; changed: boolean } {
  const templateBase = path.basename(templateFile);
  const rootRel = rootRelativeImport(root, templateFile);
  let changed = false;
  const rewritten = source.replace(
    /(#(?:import|include)\s+)"([^"]+)"/g,
    (whole, keyword: string, importPath: string) => {
      if (path.basename(importPath) !== templateBase) return whole;
      if (importPath === rootRel) return whole;
      changed = true;
      return `${keyword}"${rootRel}"`;
    },
  );
  return { source: rewritten, changed };
}

/**
 * Compile a `.typ` file directly to PDF. Returns the output path.
 *
 * If the file imports the configured template by a bare/mismatched path, that
 * import is rewritten to the template's real location and the compile runs from
 * a temporary sibling file (so the original's other relative paths still
 * resolve). `--root` is the common ancestor of the source and the template so
 * the root-relative import is expressible.
 */
export async function compileTyp(
  sourceAbs: string,
  outPdfAbs: string,
  settings: TypstPluginSettings,
): Promise<string> {
  await ensureDir(path.dirname(outPdfAbs));

  let templateFile: string | null = null;
  if (settings.templatePath) {
    try {
      templateFile = await resolveTemplateFile(settings.templatePath);
    } catch {
      // Template optional for direct .typ compiles; ignore if unresolved.
    }
  }

  const roots = templateFile ? [sourceAbs, templateFile] : [sourceAbs];
  const root = commonAncestor(roots);

  let compileTarget = sourceAbs;
  let tmpTyp: string | null = null;

  if (templateFile) {
    const original = await fs.readFile(sourceAbs, "utf8");
    const { source, changed } = rewriteTemplateImports(
      original,
      templateFile,
      root,
    );
    if (changed) {
      tmpTyp = path.join(
        path.dirname(sourceAbs),
        `.${path.basename(sourceAbs, ".typ")}.typst-compile.typ`,
      );
      await fs.writeFile(tmpTyp, source, "utf8");
      compileTarget = tmpTyp;
    }
  }

  try {
    const res = await run(
      settings.typstPath,
      ["compile", "--root", root, compileTarget, outPdfAbs],
      { cwd: path.dirname(sourceAbs) },
    );
    if (res.code !== 0) {
      throw new CompileError(res.stderr.trim() || "typst compile failed.");
    }
  } finally {
    if (tmpTyp) await fs.rm(tmpTyp, { force: true });
  }
  return outPdfAbs;
}

/**
 * Convert a Markdown file to Typst body via pandoc, wrap it in the configured
 * template, compile to PDF. Returns the output path plus any mermaid fence
 * that could not be rendered, so the caller can say so.
 */
export async function compileMarkdown(
  sourceAbs: string,
  sourceMarkdown: string,
  frontmatter: Record<string, unknown>,
  outPdfAbs: string,
  settings: TypstPluginSettings,
  vaultName: string,
  vaultRoot: string,
): Promise<{ pdfPath: string; mermaidFailures: string[] }> {
  await ensureDir(path.dirname(outPdfAbs));
  const stem = `.${path.basename(sourceAbs, path.extname(sourceAbs))}`;

  // No template configured: write the bundled one beside the wrapper (it must
  // sit under the compile root) and remove it with the wrapper.
  let bundledTemplate: string | null = null;
  if (!settings.templatePath) {
    bundledTemplate = path.join(
      path.dirname(sourceAbs),
      `${stem}.typst-template.typ`,
    );
    await fs.writeFile(bundledTemplate, BUNDLED_TEMPLATE, "utf8");
  }
  const templateFile =
    bundledTemplate ?? (await resolveTemplateFile(settings.templatePath));
  const templateFunction = bundledTemplate
    ? "template"
    : settings.templateFunction;

  // Strip YAML frontmatter before handing to pandoc (we map it ourselves),
  // then translate the two Obsidian constructs pandoc does not know about:
  // wiki links become `obsidian://` links, callouts become `#admonition`.
  let body = sourceMarkdown.replace(/^---\n[\s\S]*?\n---\n?/, "");
  body = rewriteCallouts(rewriteWikiLinks(body, vaultName));
  body = rewriteTaskStates(linkVaultPaths(body, vaultName, vaultRoot));
  // Mermaid runs before pandoc so the fence is gone by the time pandoc sees
  // the body; its SVGs and the wrapper are removed together at the end.
  const mermaid = await renderMermaid(body, sourceAbs, settings);
  body = mermaid.markdown;
  const cleanup = async (): Promise<void> => {
    if (bundledTemplate) await fs.rm(bundledTemplate, { force: true });
    for (const f of mermaid.artifacts) await fs.rm(f, { force: true });
  };
  const pandoc = await run(
    settings.pandocPath,
    // Obsidian links bare URLs; without the extension pandoc prints them as
    // plain, unclickable text.
    ["--from=markdown+autolink_bare_uris", "--to=typst", "--wrap=preserve"],
    { input: body, cwd: path.dirname(sourceAbs) },
  );
  if (pandoc.code !== 0) {
    await cleanup();
    throw new CompileError(pandoc.stderr.trim() || "pandoc conversion failed.");
  }

  // The wrapper .typ lives next to the source so relative image paths resolve.
  const tmpTyp = path.join(path.dirname(sourceAbs), `${stem}.typst-export.typ`);
  const root = commonAncestor([tmpTyp, templateFile]);
  const importPath = rootRelativeImport(root, templateFile);
  const args = buildTemplateArgs(
    frontmatter,
    settings.templateArgs,
    settings.defaultAuthor,
  );

  const wrapper = [
    `#import ${typstStringLiteral(importPath)}: *`,
    "",
    `#show: ${templateFunction}.with(`,
    `  ${args}`,
    `)`,
    "",
    // pandoc wraps tables in an unbreakable, centred figure: a long table then
    // runs through the footer instead of continuing on the next page.
    "#show figure.where(kind: table): set block(breakable: true)",
    "#show table: set align(start)",
    TASK_MARK_DEF,
    "",
    styleEnumNumbering(wrapTaskLists(pandoc.stdout)),
  ].join("\n");

  await fs.writeFile(tmpTyp, wrapper, "utf8");
  try {
    const res = await run(
      settings.typstPath,
      ["compile", "--root", root, tmpTyp, outPdfAbs],
      { cwd: path.dirname(sourceAbs) },
    );
    if (res.code !== 0)
      throw new CompileError(res.stderr.trim() || "typst compile failed.");
  } finally {
    await fs.rm(tmpTyp, { force: true });
    await cleanup();
  }
  return { pdfPath: outPdfAbs, mermaidFailures: mermaid.failures };
}

/** Compile a `.typ` file to a temporary PDF and return its bytes (for preview). */
export async function compileTypToBuffer(
  sourceAbs: string,
  settings: TypstPluginSettings,
): Promise<ArrayBuffer> {
  const tmpPdf = path.join(
    os.tmpdir(),
    `typst-preview-${path.basename(sourceAbs, ".typ")}.pdf`,
  );
  await compileTyp(sourceAbs, tmpPdf, settings);
  const bytes = await fs.readFile(tmpPdf);
  await fs.rm(tmpPdf, { force: true });
  // Copy into a standalone ArrayBuffer so it's a valid BlobPart.
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}
