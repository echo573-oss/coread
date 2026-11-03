# 知岚共读室

以 [meowmana/coread](https://github.com/meowmana/coread) 为基础的两人私用共读室，保留上游 MIT 许可。鉴权、私密草稿与最近上下文的设计参考 [idleprocesscc/co-reading-mcp](https://github.com/idleprocesscc/co-reading-mcp)，权限边界按本项目重新实现。

网页与远程 MCP 共用一个 HTTPS 入口：
- 网页：https://reading.ddnsto.com/
- MCP：https://reading.ddnsto.com/mcp
- 部署说明：[NAS 与 DDNSTO](deploy/README.md)

## 使用方式

网页登录后可导入 EPUB/TXT/Markdown、翻页、划线、批注、回复、保存进度，并导出 EPUB/Markdown 或完整书库备份。浏览器页表与 MCP 共用段落编号和 UTF-16 偏移；换设备重新排版后，段落锚点保持稳定。

默认作者为知和岚，可在设置页保存。人类新批注默认私密；保存时勾选分享，或在批注线程点击“分享给岚”后，AI 才能读取整条线程。撤回分享会阻止后续读取，不能清除 AI 已经接收的旧上下文。

## 安全与连接

没有匿名阅读模式。启动前必须设置 HTTPS 的 COREAD_PUBLIC_URL 和 scrypt 格式的 COREAD_PASSWORD_HASH。网页使用 HttpOnly/Secure 会话及同源 CSRF；远程 MCP 使用官方 SDK 提供的 OAuth 授权码、PKCE S256、DCR、刷新和撤销。MCP 凭据没有分享草稿、修改设置、删书或恢复备份的权限。

原有关门功能保留为 AI 访问开关，覆盖全部阅读工具。网页主人仍可正常管理共读室。旧 SSE 入口返回迁移提示，统一使用 /mcp。

本地 stdio 仍可通过 npm run mcp 使用，只能读取共享内容和以 AI 身份写入；它不提供网页主人权限。

## MCP 工具

保留 list_books、read_book、add_comment、list_comments、get_toc、import_book、delete_comment、update_progress、get_reading_stats、add_reading_note。新增 get_recent_activity，一次返回最近书籍位置、共享划线、批注、回复与增量游标。

list_comments 可使用 limit（最多 100）和 after_id 继续读取。普通读取不推进共享书签；read_book 保留原有 AI 阅读日志副作用，get_recent_activity 不产生阅读记录。

## 开发与检查

使用 Node.js 24。安装依赖后运行 npm run check、npm test 和 npm run build。npm run start 与 npm run mcp:sse 都启动同一个受保护的网页/MCP 服务，不再开启单独的裸露 MCP 端口。

新增集成测试覆盖匿名拒绝、CSRF、OAuth/PKCE、私密线程、额外参数拒绝、显式分享和撤回、动态游标、服务重启、令牌轮换、导入导出与备份恢复。原有分页、引文校准、阅读时长与辅助阅读测试继续保留。

## 数据

默认数据库 data/coread.db，授权数据在独立 coread.db.auth 文件中，不进入书库导出。schemaVersion 2 备份保留私密状态、作者角色、AI 阅读日志和活动数据；可迁移旧 coread v1 备份，历史人类/未知作者批注保守恢复为私密。

旧 Reading Nest 的格式尚需现场核实；新服务使用独立数据目录，部署脚本保留旧容器与挂载，不自动把不兼容数据库当作 coread 数据读取。
