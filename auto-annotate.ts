/**
 * @author jackice
 * @date 2026-10-20
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type AutoOpenMode = "off" | "create" | "write";

export interface AutoAnnotateConfig {
  autoOpen: AutoOpenMode;
  include: string[];
  onWindowClose: "mute" | "ignore";
}

export interface AutoAnnotateCandidate {
  path: string;
  markdown: string;
  onClosedWithoutFeedback: () => void;
}

interface PendingWrite {
  existedBefore: boolean;
  tool: "write" | "edit";
}

const DEFAULT_CONFIG: AutoAnnotateConfig = {
  autoOpen: "create",
  include: ["docs/superpowers/**/*.md"],
  onWindowClose: "mute",
};

const AUTO_OPEN_MODES: readonly AutoOpenMode[] = ["off", "create", "write"];

function pickConfig(raw: unknown): Partial<AutoAnnotateConfig> {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const result: Partial<AutoAnnotateConfig> = {};

  if (AUTO_OPEN_MODES.includes(obj.autoOpen as AutoOpenMode)) {
    result.autoOpen = obj.autoOpen as AutoOpenMode;
  }
  if (
    Array.isArray(obj.include) &&
    obj.include.length > 0 &&
    obj.include.every((item) => typeof item === "string" && item.length > 0)
  ) {
    result.include = obj.include as string[];
  }
  if (obj.onWindowClose === "mute" || obj.onWindowClose === "ignore") {
    result.onWindowClose = obj.onWindowClose;
  }
  return result;
}

function readConfigFile(path: string): { config: Partial<AutoAnnotateConfig>; warning?: string } {
  if (!existsSync(path)) return { config: {} };
  try {
    return { config: pickConfig(JSON.parse(readFileSync(path, "utf-8"))) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { config: {}, warning: `无法解析 ${path}: ${message}` };
  }
}

export function loadConfig(cwd: string): { config: AutoAnnotateConfig; warning?: string } {
  const globalConfig = readConfigFile(resolve(homedir(), ".pi", "agent", "annotate.json"));
  const projectConfig = readConfigFile(resolve(cwd, ".pi", "annotate.json"));

  const config: AutoAnnotateConfig = {
    ...DEFAULT_CONFIG,
    ...globalConfig.config,
    ...projectConfig.config,
  };

  const warnings = [globalConfig.warning, projectConfig.warning].filter(
    (item): item is string => Boolean(item),
  );

  const envMode = process.env.PI_ANNOTATE_AUTO;
  if (envMode) {
    if (AUTO_OPEN_MODES.includes(envMode as AutoOpenMode)) {
      config.autoOpen = envMode as AutoOpenMode;
    } else {
      warnings.push(`PI_ANNOTATE_AUTO 取值无效（${envMode}），已忽略`);
    }
  }

  return { config, warning: warnings.length > 0 ? warnings.join("；") : undefined };
}

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(`^${source}$`);
}

export function matchesInclude(absPath: string, cwd: string, include: string[]): boolean {
  if (!absPath.toLowerCase().endsWith(".md")) return false;
  const relPath = relative(cwd, absPath).split(sep).join("/");
  if (!relPath || relPath.startsWith("..")) return false;
  return include.some((pattern) => globToRegExp(pattern).test(relPath));
}

function contentHash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export function registerAutoAnnotate(
  pi: ExtensionAPI,
  open: (ctx: ExtensionContext, candidate: AutoAnnotateCandidate) => Promise<void>,
): void {
  const pending = new Map<string, PendingWrite>();
  const annotatedHash = new Map<string, string>();
  const muted = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let config: AutoAnnotateConfig | null = null;

  function ensureConfig(ctx: ExtensionContext): AutoAnnotateConfig {
    if (config) return config;
    const loaded = loadConfig(ctx.cwd);
    config = loaded.config;
    if (loaded.warning) {
      try {
        ctx.ui.notify(loaded.warning, "warning");
      } catch {
        // ctx 可能已失效，忽略
      }
    }
    return config;
  }

  function drain(ctx: ExtensionContext): void {
    const current = ensureConfig(ctx);
    const candidates = [...pending.entries()];
    pending.clear();
    if (current.autoOpen === "off") return;

    for (const [path, info] of candidates) {
      if (current.autoOpen === "create" && info.existedBefore) continue;
      if (muted.has(path)) continue;
      if (!existsSync(path)) continue;

      let markdown: string;
      try {
        markdown = readFileSync(path, "utf-8");
      } catch {
        continue;
      }

      const hash = contentHash(markdown);
      if (annotatedHash.get(path) === hash) continue;
      annotatedHash.set(path, hash);

      queue = queue
        .then(() =>
          open(ctx, {
            path,
            markdown,
            onClosedWithoutFeedback: () => {
              if (current.onWindowClose === "mute") muted.add(path);
            },
          }),
        )
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`自动批注失败: ${message}`);
          try {
            ctx.ui.notify(`自动批注失败: ${message}`, "error");
          } catch {
            // ctx 可能已失效，忽略
          }
        });
    }
  }

  pi.on("session_start", (_event, ctx) => {
    // 新会话重新读取配置，避免沿用上一个项目的设置
    config = null;
    ensureConfig(ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    const current = ensureConfig(ctx);
    if (current.autoOpen === "off") return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const rawPath = (event.input as { path?: unknown }).path;
    if (typeof rawPath !== "string" || rawPath.length === 0) return;

    const absPath = resolve(ctx.cwd, rawPath);
    if (!matchesInclude(absPath, ctx.cwd, current.include)) return;

    const previous = pending.get(absPath);
    pending.set(absPath, {
      existedBefore: previous?.existedBefore ?? existsSync(absPath),
      tool: event.toolName,
    });
  });

  pi.on("agent_settled", (_event, ctx) => {
    drain(ctx);
  });
}
