import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { spawn } from "node:child_process";
import * as path from "node:path";
import {
  DEFAULT_SETTINGS,
  TypstPluginSettings,
  TypstSettingTab,
} from "./settings";
import { TypstView, VIEW_TYPE_TYPST } from "./view";
import { compileMarkdown, compileTyp, CompileError } from "./compiler";

export default class TypstPlugin extends Plugin {
  declare settings: TypstPluginSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    if (this.settings.registerTypView) {
      this.registerView(VIEW_TYPE_TYPST, (leaf) => new TypstView(leaf, this));
      // Route .typ files to our editor. Wrapped: registering an already-known
      // extension throws, which we don't want to abort onload.
      try {
        this.registerExtensions(["typ"], VIEW_TYPE_TYPST);
      } catch (e) {
        console.warn("typst-studio: could not register .typ extension", e);
      }
    }

    this.addSettingTab(new TypstSettingTab(this.app, this));

    this.addCommand({
      id: "export-current-to-pdf",
      name: "Export current file to PDF",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok =
          !!file && (file.extension === "md" || file.extension === "typ");
        if (ok && !checking) void this.exportFileToPdf(file as TFile);
        return ok;
      },
    });

    this.addRibbonIcon("file-output", "Export to PDF (Typst)", () => {
      const file = this.app.workspace.getActiveFile();
      if (file && (file.extension === "md" || file.extension === "typ")) {
        void this.exportFileToPdf(file);
      } else {
        new Notice("Open a .md or .typ file to export.");
      }
    });

    // Right-click on .md / .typ files in the explorer.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (
          file instanceof TFile &&
          (file.extension === "md" || file.extension === "typ")
        ) {
          menu.addItem((item) =>
            item
              .setTitle("Export to PDF (Typst)")
              .setIcon("file-output")
              .onClick(() => void this.exportFileToPdf(file)),
          );
        }
      }),
    );
  }

  onunload(): void {}

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private vaultBasePath(): string {
    // @ts-expect-error getBasePath exists on the desktop FileSystemAdapter.
    return this.app.vault.adapter.getBasePath();
  }

  /** Resolve the output PDF path for a given source file, honouring settings. */
  private outputPathFor(file: TFile): string {
    const base = this.vaultBasePath();
    const sourceAbs = path.join(base, file.path);
    const pdfName = `${file.basename}.pdf`;
    if (!this.settings.outputDir) {
      return path.join(path.dirname(sourceAbs), pdfName);
    }
    const outDir = path.isAbsolute(this.settings.outputDir)
      ? this.settings.outputDir
      : path.join(base, normalizePath(this.settings.outputDir));
    return path.join(outDir, pdfName);
  }

  /** Compile a .md (via Typst) or .typ file to PDF and optionally open it. */
  async exportFileToPdf(file: TFile): Promise<void> {
    const base = this.vaultBasePath();
    const sourceAbs = path.join(base, file.path);
    const outPdf = this.outputPathFor(file);
    const notice = new Notice(`Compiling ${file.name}…`, 0);
    try {
      let mermaidFailures: string[] = [];
      if (file.extension === "typ") {
        await compileTyp(sourceAbs, outPdf, this.settings);
      } else {
        const content = await this.app.vault.read(file);
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
        ({ mermaidFailures } = await compileMarkdown(
          sourceAbs,
          content,
          fm,
          outPdf,
          this.settings,
          this.app.vault.getName(),
          base,
        ));
      }
      notice.hide();
      new Notice(`Saved ${path.basename(outPdf)}`);
      // A fence that did not render is still in the PDF, as source. Say so
      // rather than letting a code block pass for a diagram.
      if (mermaidFailures.length)
        new Notice(
          `${mermaidFailures.length} mermaid diagram(s) left as code: ${mermaidFailures[0]}`,
          10000,
        );
      if (this.settings.openAfterCompile) this.openExternally(outPdf);
    } catch (err) {
      notice.hide();
      const msg =
        err instanceof CompileError || err instanceof Error
          ? err.message
          : String(err);
      new Notice(`Typst export failed: ${msg}`, 10000);
      console.error("typst-studio: export failed", err);
    }
  }

  private openExternally(filePath: string): void {
    // `open` on macOS, `xdg-open` on Linux, `start` on Windows.
    const platform = process.platform;
    const cmd =
      platform === "darwin"
        ? "open"
        : platform === "win32"
          ? "cmd"
          : "xdg-open";
    const args =
      platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  }
}
