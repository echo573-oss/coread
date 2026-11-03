# 知岚共读室：NAS 与 DDNSTO

一个 Node/SQLite 容器提供网页 `/`、API `/v1/*`、MCP `/mcp` 和 OAuth 发现端点。公开基础地址固定为 `https://reading.ddnsto.com`，复用现有 DDNSTO 的 HTTPS 终止与转发，不创建新域名。

## 部署前

先确认 NAS 架构、旧 Reading Nest 容器名称、主机端口和数据挂载。旧容器及其挂载保留，新的共读室使用独立 `data/`。Reading Nest 的数据库格式未知，不把它直接交给本程序迁移，也不宣称旧批注已经导入。

NAS 需要 Docker、Compose 与构建镜像所需网络。Dockerfile 使用 Node 24、多阶段构建和非 root 运行；构建阶段可编译 SQLite 本机扩展。不要把旧应用的数据卷挂进新服务。

## 分两步上线

先运行 `deploy/install-nas.sh`，只构建并启动新的暂存服务，默认绑定 NAS 的 `127.0.0.1:3010`。脚本验证健康状态以及匿名 API/MCP 返回 401，旧服务不受影响。没有 Node 主机依赖：初始配置由容器内 Node 生成。

初次生成 `.env` 和 `.env.initial-password.txt`，文件权限为 600。密码只存在本机初始文件，收入密码管理器后删除；聊天、日志和源码仓库中不保存密码。`.env` 中只有 scrypt 摘要。NAS 的用户 UID/GID 写入配置，数据目录权限为 700。

确认旧容器名称和 DDNSTO 原来转发的主机端口后，向脚本传入三个明确参数：旧容器名、旧主机端口、NAS 的绑定 IP。脚本先检查端口确实属于旧容器，暂存检查通过后才停止旧容器，让新服务使用同一端口。新服务和公网 `/healthz`、匿名 `/mcp` 检查失败会恢复旧容器原状态；不删除容器或数据卷。

如果 DDNSTO 指向容器 IP 而非 NAS 主机端口，不使用这条端口替换流程。需要先核实并调整转发目标，让 `/`、`/mcp`、`/authorize`、`/token`、`/register`、`/revoke`、`/auth/*` 和 `/.well-known/*` 都到同一个容器。不要只代理 `/mcp`，也不要让 DDNSTO 的额外网页登录挡住 OAuth 元数据或令牌端点。

## Work 连接

入口为 `https://reading.ddnsto.com/mcp`，选择 OAuth。支持授权码 + PKCE S256、DCR、刷新和撤销。登录后查看客户端名和回调域名，再允许连接。Work 的令牌只能访问共享内容，以 AI 身份写入；不具有网页主人权限。

对应发现地址：`/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server`。授权 `/authorize`、令牌 `/token`、注册 `/register`、撤销 `/revoke`。注册的回调地址由客户端提供并校验，不需要把网页登录密码交给 Work。

`deploy/work-plugin/` 提供不含凭据的插件配置。云端 Work 还需要在 ChatGPT 插件界面注册/安装该远程连接；仅有本地文件或桌面配置不代表云端已接通。实际验收必须包含云端授权、列工具、读最近动态、写回复，以及私密批注拒读。

## 数据和维护

网页默认作者名为知/岚，可以在原设置页保存。新建批注默认私密，勾选分享或对整条线程点击分享后，AI 才能读取。撤回分享只阻止后续读取，不能清除已经传给 AI 的旧上下文。

数据为 `data/coread.db`，授权记录为独立 `data/coread.db.auth`。网页完整备份为 schemaVersion 2，不包含授权数据库；兼容旧 coread v1 备份，未知/人类历史批注保守迁移为私密。旧程序回退必须使用迁移前的一致性备份，不能直接打开新库。

需要更换网页密码时生成新的 scrypt 摘要更新 `.env` 并重启；凭据变化会使原网页会话与 AI 令牌失效。设置页可退出当前登录、撤销全部 AI 授权。

已确认基础入口以前返回 502 时，先排查 DDNSTO 客户端与旧目标服务。容器内健康通过不能替代公网检查。Docker 构建、NAS 实际运行和云端 Work 的状态须分别汇报。
