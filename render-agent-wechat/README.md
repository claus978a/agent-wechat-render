# agent-wechat on Render（免费版）— 微信群机器人部署

> 目标：在 Render 免费服务器上跑 agent-wechat（微信协议客户端，不用官方微信客户端、不用桌面），登录小号 **光谱**，收发三人群「Pudding、yuki (3)」的消息。
>
> 为什么换到这儿：原来那台服务器连不上微信消息服务器（登录能上，收发全死），Render 是美国机房直连公网，理论上能连上。部署后第一件事就是实测。

## 这个仓库里有什么

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 部署用的镜像：Node 24 + ffmpeg + agent-wechat v2.2.0（官方二进制，SHA256 校验过） |
| `proxy.js` | 小代理：Render 要求服务监听 `0.0.0.0:$PORT`，但 daemon 只肯监听本机（127.0.0.1），所以由它对外暴露 `/health` |
| `start.sh` | 启动脚本：先起 daemon（本机 6174 端口），再起 proxy（对外 $PORT） |
| `package.json` | 只是说明文件（Render 用 Dockerfile 部署，不靠它） |
| `render.yaml` | 可选：Render Blueprint，一键建服务用的 |
| `watch.sh` | 可选：在 Render Shell 里看新消息用的小脚本 |

## 先说清楚的三个硬伤（部署前必读）

1. **重启就要重新扫码。** Render 免费版没有持久硬盘，容器一重启（重新部署、Render 维护），登录会话就丢了，得重新扫一次码。平时有保活的话重启很少，但这点要接受。
2. **登录会顶掉旧的。** 微信一次只能有一个桌面会话。在这儿扫码登录小号光谱后，原来那台服务器上的微信登录会被顶掉（反正那边的收发本来就是死的）。
3. **封号风险。** agent-wechat 是非官方的逆向协议客户端，腾讯可能封号。所以只用小号光谱，千万别用大号登录。

## 第一步：把文件传到 GitHub（用户名 claus978a）

1. 打开 GitHub，点右上角 `+` → `New repository`。
2. Repository name 填 `agent-wechat-render`，选 Public（免费版部署公开仓库最省事；里面没有任何密码和密钥，放心），点 `Create repository`。
3. 在新建的仓库页面点 `uploading an existing file`（或者 `Add file` → `Upload files`），把这个文件夹里的 **全部文件**（Dockerfile、proxy.js、start.sh、package.json、render.yaml、watch.sh、README.md）拖进去，点 `Commit changes`。
4. 确认仓库里有 `Dockerfile`（Render 靠它部署）。

## 第二步：在 Render 上建服务（不要卡、不要地址）

1. 打开 https://render.com ，点 `Sign Up`，用 GitHub 登录（或者邮箱注册）。**全程不问银行卡、不问地址。**
2. 登录后点 `New +` → `Web Service`。
3. 选 `Build and deploy from a Git repository` → `Next`，找到并选中你刚建的 `claus978a/agent-wechat-render` 仓库（第一次要授权 Render 访问 GitHub，按提示点 Allow）。
4. 按下面填：
   - **Name**：`agent-wechat`（随便起，记好就行）
   - **Region**：选 `Oregon (US West)`（免费版只有美国区）
   - **Branch**：`main`
   - **Runtime**：`Docker`（Render 检测到 Dockerfile 会自动选）
   - **Instance Type**：选 `Free`（512MB 内存，免费）
   - 其他不用动，点 `Create Web Service`。
5. 等部署完成（第一次要几分钟，下载 Node 镜像、装 ffmpeg、下载 wx 程序）。状态变成 `Live` 就是跑起来了。记下服务给你的网址，比如 `https://agent-wechat-xxxx.onrender.com`。
6. 打开 `https://你的网址/health`，应该看到 `{"status":"ok"}`。看到就说明 daemon 在跑。

## 第三步：实测能不能连上微信服务器（必须做）

1. 在 Render 服务页面，点右上角 `Shell`（网页终端）。
2. 在 Shell 里跑：
   ```bash
   openssl s_client -connect long.weixin.qq.com:443 -servername long.weixin.qq.com </dev/null 2>&1 | head -5
   ```
   如果看到一堆证书信息（`Certificate chain` / `Verify return code`），说明能连上，继续。
   如果看到 `wrong version number` 或连不上，说明这条路也走不通，停下来告诉我，别往下走了。

## 第四步：登录小号光谱（扫码）

1. 还在 Render Shell 里，先建一个账号位：
   ```bash
   wx accounts create --alias guangpu
   ```
2. 然后登录（二维码会直接印在终端里）：
   ```bash
   wx auth login
   ```
   - 终端里会出现一个二维码（黑白方块）。**用手机微信扫一扫**（微信里点右上角 + → 扫一扫，对着电脑屏幕上的码扫）。
   - 手机上出来确认就点确认。终端显示登录成功就好了。
   - 注意：手机必须登着小号 **光谱** 再扫；二维码几分钟会过期，过期它会自动换一个（最多换 3 次），换了就扫新的。
   - ⚠️ 扫码成功后，**不要再把这个手机切回大号**，不然电脑这边会掉线。
3. 检查登录成功：
   ```bash
   wx accounts list
   wx chats list --limit 20
   ```
   `chats list` 里应该能看到三人群，找到它的 ID（形如 `xxxxx@chatroom`），记下来，后面发消息要用。

## 第五步：防休眠保活（UptimeRobot，免费）

Render 免费版 15 分钟没人访问会自动睡觉，睡了微信就断连。用免费的 UptimeRobot 每 5 分钟叫它一声：

1. 打开 https://uptimerobot.com 注册免费账号（邮箱就行，不要卡）。
2. `Add New Monitor`，按下面填：
   - **Monitor Type**：`HTTP(s)`
   - **Friendly Name**：`agent-wechat`（随便）
   - **URL or IP**：填你 Render 服务的网址 + `/health`，比如 `https://agent-wechat-xxxx.onrender.com/health`
   - **Monitoring Interval**：`5 minutes`
3. 保存。以后它每 5 分钟 ping 一次，服务就不会睡了。

## 平时怎么用（在 Render Shell 里）

```bash
# 看最近的会话（找群 ID）
wx chats list --limit 20

# 看某个群最近的消息（把 CHAT_ID 换成群的 @chatroom ID）
wx messages list 'xxxxx@chatroom' --limit 20

# 在群里发消息（--mention 可以 @ 某个人）
wx messages send 'xxxxx@chatroom' --text "你好，我是光谱"

# 实时看新消息（有新消息就一行一行打出来，Ctrl-C 停）
bash watch.sh

# 看 daemon 状态
wx daemon status
wx status
```

## 出问题怎么办

| 现象 | 怎么办 |
|---|---|
| 打开 `/health` 不是 `{"status":"ok"}` | 在 Render 页面点 `Manual Deploy` → `Deploy latest commit` 重新部署；再看日志（`Logs` 标签页） |
| Shell 里 `wx` 说连不上 daemon | 先看 `wx daemon status`；如果 daemon 停了，重启服务（Render 页面 `Restart`） |
| 群里收不到消息 / 发不出去 | 先在 Shell 里跑第三步的 `openssl` 测试，确认还能连上微信服务器；如果连不上，是 Render 网络问题，告诉我 |
| 容器重启后要重新登录 | 正常现象（免费版没硬盘）。按第四步重新 `wx auth login` 扫码就行 |
| 登录时二维码扫出来是网页 | 用微信里的扫一扫，别用手机相机；手机要登着小号光谱；换个新码再扫 |

## 费用

全程 $0：GitHub 免费、Render 免费版、UptimeRobot 免费版。没有任何卡、任何扣费。
