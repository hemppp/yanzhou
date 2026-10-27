<!--
砚舟 PR 模板
提交前请完成 Author 自检（Definition of Ready）与安全自查；reviewer 按本模板逐项审查。
-->

## 改动摘要（必填）
<!-- 要解决什么问题？怎么验证？影响哪些模块？ -->

## 类型
- [ ] feat（新功能）
- [ ] fix（Bug 修复）
- [ ] refactor（重构）
- [ ] docs（文档）
- [ ] test（测试）
- [ ] chore（构建/工具）

## 风险与影响
- [ ] 涉及安全 / 认证 / 授权
- [ ] 涉及 Drizzle schema 或迁移
- [ ] 涉及对外 API 契约 / `@novel/shared` 类型
- [ ] 涉及 Tauri 桌面端
- [ ] 涉及 AI Agents（Python）
- [ ] UI 变更（建议附截图/录屏）

## Author 自检（Definition of Ready）
- [ ] `pnpm -r type-check` 通过
- [ ] `pnpm -r lint` 通过
- [ ] 相关测试 `pnpm --filter @novel/web test` 通过（server/agents 如有测试也需过）
- [ ] 接口变更已同步 `@novel/shared` 类型与前端调用
- [ ] Drizzle schema 变更已生成迁移
- [ ] 已知问题（🟡）已登记 follow-up issue

## 安全自查（🔴 重点，漏审会阻塞合并）
- [ ] 所有访问他人数据的接口都走了 `verifyProjectOwnership`
- [ ] **请求体里的 `projectId` 也做了所有权校验**（不仅是 URL 参数）
- [ ] 敏感路由都挂了 `requireAuth`
- [ ] 无硬编码密钥；外部/AI 调用有超时与错误处理
- [ ] 富文本/Markdown 渲染经过 `dompurify` 清洗，无裸 `dangerouslySetInnerHTML`

## Reviewer 结论（由 reviewer 填写）
- 严重级别汇总：🔴 __ / 🟡 __ / 💭 __
- 总评：Request changes / Approved / Approved with nits
- 重点核对了：
