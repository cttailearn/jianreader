## 0.3.2 - 2026-09-02 —— 全量审查修复（R-01~R-28）

> 依据 `docs/审查报告-简阅-2026-09-02.md` 实施的全面修复：数据安全 / 安全纵深 / 正确性 / 性能 / 工程基建。

### 数据安全（P0）
- 小说模式改为「分章草稿」：编辑内容按章保存草稿，切章/退出/重载不再丢弃；保存一次性写回全部已修改章节（倒序保证字节偏移有效）；保存期间继续输入会保留并提示再次保存
- 关闭窗口前拦截：存在未保存修改时弹「保存并退出/不保存退出/取消」，杜绝静默丢失
- 保存冲突检测：普通标签与小说均在保存起点做快照，写盘期间的新输入不再被静默丢弃

### 安全
- 启用严格 CSP（生产 `default-src 'self'`、无内联脚本；开发 `devCsp` 兼容 Vite HMR）
- asset 协议作用域收窄为按「用户打开的目录」动态放行；全部文件命令增加路径作用域校验；删除改走回收站
- 多窗口最小能力集拆分；Markdown 远端图片加 `no-referrer`
- **更新数字签名验签（ECDSA P-256）**：更新来源改为 GitHub `releases/latest` API，**不再需要 latest.json**；发布时 `scripts/sign-release.mjs` 把 `sig:` 写入 Release 备注，客户端 WebCrypto 对 `version+sha256` 验签（fail-closed）；新增 `verify-manifest.mjs` 发布前自检

### 正确性 / 性能 / 工程
- UTF-16 无 BOM 保存不再强制加 BOM；大文本传输改 raw IPC；标签内存 LRU 逐出；章节流式扫描
- 小说段落渐进式渲染（超大单章不再一次性渲染几万行）；CodeMirror 动态导入
- 新增 GitHub Actions CI（tsc + eslint + 构建 + cargo test）；释放脚本三处版本一致性校验
