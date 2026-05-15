/**
 * @author jackice
 * @date 2026-05-15
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as os from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { startAnnotationServer, type Annotation } from "./server.js";

// ── Types ──────────────────────────────────────────────────────────────

interface GlimpseWindow {
  on(event: "closed", handler: () => void): void;
  close(): void;
}

// ── Glimpse Integration ────────────────────────────────────────────────

let glimpseOpen: ((html: string, opts: Record<string, unknown>) => GlimpseWindow) | null | undefined;

function findGlimpseMjs(): string | null {
  try {
    const req = createRequire(import.meta.url);
    return req.resolve("glimpseui");
  } catch {
    // not in local node_modules
  }
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim();
    const entry = resolve(globalRoot, "glimpseui", "src", "glimpse.mjs");
    if (existsSync(entry)) return entry;
  } catch {
    // npm root -g failed
  }
  return null;
}

async function getGlimpseOpen(): Promise<typeof glimpseOpen> {
  if (glimpseOpen !== undefined) return glimpseOpen;
  const resolved = findGlimpseMjs();
  if (resolved) {
    try {
      glimpseOpen = (await import(resolved)).open;
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
      const tag = a.type === "comment" ? "评论" : a.type === "suggestion" ? "建议修改" : a.type === "issue" ? "问题" : "表扬";
      return `- **${a.type}**: ${tag}
  > 原文: "${a.originalText || "(无原文)"}"
  ${a.text}`;
    })
    .join("\n\n");

  const hasIssues = annotations.some((a) => a.type === "issue");
  const hasSuggestions = annotations.some((a) => a.type === "suggestion");
  let ending: string;
  if (hasIssues) {
    ending = "请修复以上问题。";
  } else if (hasSuggestions) {
    ending = "请根据以上建议进行修订。";
  } else {
    ending = "请参考以上批注意见。";
  }

  return `## 批注反馈\n\n以下是对 ${sourceInfo} 的批注意见：\n\n${items}\n\n${ending}`;
}

// ── Shared annotation flow ─────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

async function readAnnotateHtml(): Promise<string> {
  const htmlPath = resolve(__dirname, "form", "annotate.html");
  return readFileSync(htmlPath, "utf-8");
}

async function openAnnotationServer(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: {
    markdown: string;
    mode: "annotate" | "annotate-last";
    sourceInfo: string;
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



  let glimpseWin: GlimpseWindow | null = null;

  // macOS 上优先 Glimpse，回退浏览器
  if (os.platform() === "darwin") {
    const glimpseOpenFn = await getGlimpseOpen();
    if (glimpseOpenFn) {
      try {
        glimpseWin = openInGlimpse(glimpseOpenFn, server.url, `批注: ${options.sourceInfo}`);
        ctx.ui.notify("批注窗口已打开，完成后关闭即可。", "info");

        // 监听 Glimpse 窗口关闭事件 — 窗口关闭时自动触发退出
        let windowClosed = false;
        glimpseWin.on("closed", () => {
          windowClosed = true;
          fetch(`${server.url}/api/exit`, { method: "POST", keepalive: true }).catch(() => {});
        });

        // 等待决策
        const decision = await server.waitForDecision();

        // 窗口关闭触发的 exit，静默处理
        if (decision.action === "exit" && windowClosed) {
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
    const decision = await server.waitForDecision();
    handleAnnotationDecision(pi, ctx, decision, options.sourceInfo, options.markdown);
    server.stop();
  } catch (err) {
    ctx.ui.notify(`打开批注失败: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

function handleAnnotationDecision(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
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
        feedbackText = `## 批注反馈\n\n以下是对 ${sourceInfo} 的批注意见，请根据以上建议进行修订。`;
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

      return openAnnotationServer(pi, ctx, {
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

        return openAnnotationServer(pi, ctx, {
          markdown: content,
          mode: "annotate",
          sourceInfo: filePath,
        });
      } catch (err) {
        ctx.ui.notify(`批注失败: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // ── Hook: turn_end 自动检测 ──────────────────────────────────────────

  pi.on("turn_end", async (event, ctx) => {
    // 只处理 assistant 消息
    if (event.message.role !== "assistant") return;

    const parts = event.message.content.filter((c) => c.type === "text");
    const text = parts.map((c) => c.text).join("");
    if (!text) return;

    // 匹配 docs/superpowers/ 下的文件路径
    const pattern = /docs\/superpowers\/(specs|plans)\/[^\s,.;:()!?]+\.md/g;
    const matches = text.match(pattern);
    if (!matches || matches.length === 0) return;

    let foundPath: string | null = null;
    for (const match of matches) {
      const absolutePath = resolve(ctx.cwd, match);
      if (existsSync(absolutePath)) {
        foundPath = absolutePath;
        break;
      }
    }

    if (!foundPath) return;

    ctx.ui.notify("检测到新文档，正在打开批注...", "info");

    const content = readFileSync(foundPath, "utf-8");
    const htmlContent = await readAnnotateHtml();

    try {
      const server = await startAnnotationServer({
        markdown: content,
        htmlContent,
        mode: "annotate",
        sourceInfo: foundPath,
        gate: false,
      });

      // macOS 上优先 Glimpse
      if (os.platform() === "darwin") {
        const glimpseOpenFn = await getGlimpseOpen();
        if (glimpseOpenFn) {
          try {
            const glimpseWin = openInGlimpse(glimpseOpenFn, server.url, `批注: ${foundPath}`);
            let windowClosed = false;
            glimpseWin.on("closed", () => {
              windowClosed = true;
              fetch(`${server.url}/api/exit`, { method: "POST", keepalive: true }).catch(() => {});
            });
            const decision = await server.waitForDecision();
            if (decision.action === "exit" && windowClosed) {
              server.stop();
              return;
            }
            if (!(decision.action === "exit" && windowClosed)) {
              handleAnnotationDecision(pi, ctx, decision, foundPath, content);
            }
            server.stop();
            return;
          } catch {
            // 回退浏览器
          }
        }
      }

      await openUrl(pi, server.url);
      const decision = await server.waitForDecision();
      handleAnnotationDecision(pi, ctx, decision, foundPath, content);
      server.stop();
    } catch (err) {
      console.error(`自动批注失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
