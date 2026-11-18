# 关系识别评测（一次性脚本）

10 章测试文本 → 逐章调用 `/api/ai/scan-timeline-stream` → 用**客户端同一套**
`relationRecognition` 校验 → 统计召回/精度。

- `chapters.mjs` — 10 章正文（刻意写满可核对的关系事实）
- `eval-client.ts` — 跑评测并打印分数（`node node_modules/tsx/dist/cli.mjs scripts/tmp-recognition-eval/eval-client.ts http://127.0.0.1:3899`）
- `seed.ts` — 把扫描结果按产品接口写进项目库，供 UI 查看
- `result-client.json` / `ui-data.txt` — 最近一次结果

服务端需先把 AI provider 指向可用网关（`POST /api/ai/config`）。
