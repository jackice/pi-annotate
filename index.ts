/**
 * @author jackice
 * @date 2026-05-15
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { startAnnotationServer, type Annotation } from "./server.js";
import { registerAutoAnnotate } from "./auto-annotate.js";

// ── Types ──────────────────────────────────────────────────────────────

interface GlimpseWindow {
  on(event: "closed", handler: () => void): void;
  close(): void;
}

// ── Glimpse Integration ────────────────────────────────────────────────

let glimpseOpen: ((html: string, opts: Record<string, unknown>) => GlimpseWindow) | null | undefined;

function findGlimpseMjs(): string | null {
  // 从当前模块目录向上逐级查找 node_modules/glimpseui/src/glimpse.mjs。
  // 不用 createRequire().resolve()：omp 的扩展加载器会劫持 createRequire，
  // 使其只认已注册模块而不查文件系统，导致包解析失败。
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = resolve(dir, "node_modules", "glimpseui", "src", "glimpse.mjs");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // npm 全局目录（README 推荐的 npm install -g 方式）
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim();
    const entry = resolve(globalRoot, "glimpseui", "src", "glimpse.mjs");
    if (existsSync(entry)) return entry;
  } catch {
    // npm root -g failed
  }
  // bun 全局目录（bun add -g 安装位置）
  try {
    const bunRoot = resolve(os.homedir(), ".bun", "install", "global", "node_modules");
    const entry = resolve(bunRoot, "glimpseui", "src", "glimpse.mjs");
    if (existsSync(entry)) return entry;
  } catch {
    // homedir failed
  }
  return null;
}

async function getGlimpseOpen(): Promise<typeof glimpseOpen> {
  if (glimpseOpen !== undefined) return glimpseOpen;
  const resolved = findGlimpseMjs();
  if (resolved) {
    try {
      // 用 file:// URL 显式导入，兼容 pi 与 omp 两种扩展加载器
      glimpseOpen = (await import(pathToFileURL(resolved).href)).open;
      return glimpseOpen;
    } catch {
      // import failed
    }
  }
  glimpseOpen = null;
  return glimpseOpen;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function openInGlimpse(
  open: (html: string, opts: Record<string, unknown>) => GlimpseWindow,
  url: string,
  title?: string,
): GlimpseWindow {
  const safeTitle = escapeHtml(title || "批注");
  const shellHTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>${safeTitle}</title></head>
<body style="margin:0; background:#1a1a2e;">
  <script>window.location.replace(${JSON.stringify(url)});</script>
</body>
</html>`;
  return open(shellHTML, { width: 900, height: 750, title: title || "批注" });
}

async function openUrl(pi: ExtensionAPI, url: string): Promise<void> {
  const platform = os.platform();
  let result: { code: number; stderr?: string };
  if (platform === "darwin") {
    result = await pi.exec("open", [url]);
  } else if (platform === "win32") {
    result = await pi.exec("cmd", ["/c", "start", "", url]);
  } else {
    result = await pi.exec("xdg-open", [url]);
  }
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function getLastAssistantMessageText(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && "message" in entry) {
      const msg = entry.message;
      if (msg.role === "assistant") {
        const parts = msg.content.filter((c) => c.type === "text");
        const text = parts.map((c) => c.text).join("").trim();
        if (text) return text;
      }
    }
  }
  return null;
}

function formatAnnotationFeedback(
  annotations: Annotation[],
  sourceInfo: string,
): string {
  if (!annotations || annotations.length === 0) return "";
  const items = annotations
    .map((a) => {
      const tag = a.type === "comment" ? "Comment" : a.type === "suggestion" ? "Suggestion" : a.type === "issue" ? "Issue" : "Praise";
      return `- **${a.type}**: ${tag}
  > Original text: "${a.originalText || "(none)"}"
  ${a.text}`;
    })
    .join("\n\n");

  const hasIssues = annotations.some((a) => a.type === "issue");
  const hasSuggestions = annotations.some((a) => a.type === "suggestion");
  let ending: string;
  if (hasIssues) {
    ending = "Please address the issues above.";
  } else if (hasSuggestions) {
    ending = "Please revise according to the suggestions above.";
  } else {
    ending = "Please consider the feedback above.";
  }

  return `## Annotation Feedback\n\nThe following feedback was provided for ${sourceInfo}:\n\n${items}\n\n${ending}`;
}

// ── Shared annotation flow ─────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

async function readAnnotateHtml(): Promise<string> {
  const htmlPath = resolve(__dirname, "form", "annotate.html");
  return readFileSync(htmlPath, "utf-8");
}

type AnnotationDecision = {
  action: "feedback" | "approve" | "exit";
  feedback?: string;
  annotations?: Annotation[];
};

async function waitForDecisionAbortable(
  server: { waitForDecision: () => Promise<AnnotationDecision> },
  signal?: AbortSignal,
): Promise<AnnotationDecision | null> {
  if (!signal) return server.waitForDecision();
  if (signal.aborted) return null;

  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    server.waitForDecision().then(
      (decision) => {
        signal.removeEventListener("abort", onAbort);
        resolve(decision);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function openAnnotationSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: {
    markdown: string;
    mode: "annotate" | "annotate-last";
    sourceInfo: string;
    signal?: AbortSignal;
    onClosedWithoutFeedback?: () => void;
  },
): Promise<void> {
  const htmlContent = await readAnnotateHtml();

  const server = await startAnnotationServer({
    markdown: options.markdown,
    htmlContent,
    mode: options.mode,
    sourceInfo: options.sourceInfo,
    gate: false,
  });

  // macOS 上优先 Glimpse，回退浏览器
  if (os.platform() === "darwin") {
    const glimpseOpenFn = await getGlimpseOpen();
    if (glimpseOpenFn) {
      try {
        const win = openInGlimpse(glimpseOpenFn, server.url, `批注: ${options.sourceInfo}`);
        ctx.ui.notify("批注窗口已打开，完成后关闭即可。", "info");

        // 监听 Glimpse 窗口关闭事件 — 窗口关闭时直接决议退出，不依赖 HTTP fetch
        let windowClosed = false;
        win.on("closed", () => {
          windowClosed = true;
          server.resolveDecision({ action: "exit" });
        });

        // 等待决策；会话切换时中止
        const decision = await waitForDecisionAbortable(server, options.signal);
        if (!decision) {
          win.close();
          server.stop();
          return;
        }

        // 窗口关闭触发的 exit，静默处理
        if (decision.action === "exit" && windowClosed) {
          options.onClosedWithoutFeedback?.();
          server.stop();
          return;
        }

        handleAnnotationDecision(pi, ctx, decision, options.sourceInfo, options.markdown);
        server.stop();
        return;
      } catch (err) {
        ctx.ui.notify(`Glimpse 失败，回退浏览器: ${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    }
  }

  // 回退：浏览器打开
  try {
    await openUrl(pi, server.url);
    const decision = await waitForDecisionAbortable(server, options.signal);
    if (!decision) {
      server.stop();
      return;
    }
    if (decision.action === "exit") options.onClosedWithoutFeedback?.();
    handleAnnotationDecision(pi, ctx, decision, options.sourceInfo, options.markdown);
    server.stop();
  } catch (err) {
    ctx.ui.notify(`打开批注失败: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

function handleAnnotationDecision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  decision: { action: "feedback" | "approve" | "exit"; feedback?: string; annotations?: Annotation[] },
  sourceInfo: string,
  originalMarkdown: string,
): void {
  switch (decision.action) {
    case "feedback": {
      let feedbackText = decision.feedback;
      // 如果有结构化 annotations 但无 feedback 文本，生成格式化反馈
      if (!feedbackText && decision.annotations && decision.annotations.length > 0) {
        feedbackText = formatAnnotationFeedback(decision.annotations, sourceInfo);
      }
      // 如果还没有反馈文本，使用默认格式
      if (!feedbackText) {
        feedbackText = `## Annotation Feedback\n\nThe following feedback was provided for ${sourceInfo}. Please revise according to the suggestions above.`;
      }
      pi.sendUserMessage(feedbackText, { deliverAs: "followUp" });
      break;
    }
    case "approve":
      ctx.ui.notify(`${sourceInfo} 已批准`, "success");
      break;
    case "exit":
      // 静默关闭
      break;
  }
}

// ── Extension Entry ────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Command: /annotate-last ──────────────────────────────────────────

  pi.registerCommand("annotate-last", {
    description: "批注当前会话中最后一条 assistant 消息",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const text = getLastAssistantMessageText(ctx);
      if (!text) {
        ctx.ui.notify("未找到 assistant 消息", "error");
        return;
      }

      ctx.ui.notify("正在打开最后一条消息的批注...", "info");

      return openAnnotationSession(pi, ctx, {
        markdown: text,
        mode: "annotate-last",
        sourceInfo: "最后一条消息",
      });
    },
  });

  // ── Command: /annotate <file> ────────────────────────────────────────

  pi.registerCommand("annotate", {
    description: "批注指定的 markdown 文档",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const filePath = args.trim().replace(/^@/, "");


        if (!filePath) {
          ctx.ui.notify("用法: /annotate <file.md>", "error");
          return;
        }

        const absolutePath = resolve(ctx.cwd, filePath);


        if (!existsSync(absolutePath)) {
          ctx.ui.notify(`文件不存在: ${absolutePath}`, "error");
          return;
        }

        ctx.ui.notify(`正在打开 ${filePath} 的批注...`, "info");

        const content = readFileSync(absolutePath, "utf-8");

        return openAnnotationSession(pi, ctx, {
          markdown: content,
          mode: "annotate",
          sourceInfo: filePath,
        });
      } catch (err) {
        ctx.ui.notify(`批注失败: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // ── Hook: 自动批注（write/edit 触发，agent_settled 打开） ────────────

  registerAutoAnnotate(pi, async (ctx, candidate) => {
    await openAnnotationSession(pi, ctx, {
      markdown: candidate.markdown,
      mode: "annotate",
      sourceInfo: candidate.path,
      signal: candidate.signal,
      onClosedWithoutFeedback: candidate.onClosedWithoutFeedback,
    });
  });
}
