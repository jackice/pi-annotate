# Contributing

感谢你考虑为 pi-annotate 做贡献！

## 开发流程

1. Fork 本仓库
2. 从 `develop` 分支创建你的功能分支：`git checkout -b feature/your-feature develop`
3. 提交你的修改
4. 确保提交信息清晰描述改动
5. 向 `develop` 分支发起 Pull Request

## Pull Request 规范

- PR 标题简明扼要说明改动
- 描述中说明改动原因和验证方式
- 保持改动聚焦，一个 PR 一个功能/修复
- 不要包含无关的格式调整

## 代码风格

- 遵循项目已有的代码风格
- TypeScript 代码使用 `@earendil-works/pi-coding-agent` 的类型
- 纯 HTML 单页（`form/annotate.html`）不引入外部依赖

## 提交信息

```
feat: 新功能描述
fix: 修复描述
chore: 工程化变更
docs: 文档变更
```

## 分支策略

- `main` — 稳定发布分支，受保护，需通过 PR 合并
- `develop` — 开发分支，所有 PR 合并到此处
- `feature/*` — 功能分支
- `fix/*` — 修复分支
