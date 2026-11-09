# agent-wechat on Render（免费版）— 微信群机器人部署

> 目标：在 Render 免费服务器上跑 agent-wechat（微信协议客户端，不用官方微信客户端、不用桌面），登录小号 **光谱**，收发三人群「Pudding、yuki (3)」的消息。
>
> 为什么换到这儿：原来那台服务器连不上微信消息服务器（登录能上，收发全死），Render 是美国机房直连公网，理论上能连上。部署后第一件事就是实测。
>
> **重要：Render 的 Shell（网页终端）是付费功能，免费版没有。** 所以下面所有步骤都不用 Shell，全部在浏览器里完成：连通性测试、扫码登录、看群聊、发消息，都走服务自己的网页（`proxy.js` 提供）。

## 这个仓库里有什么

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 部署用的镜像：Node 24 + ffmpeg + agent-wechat v2.2.0（官方二进制，SHA256 校验过） |
| `proxy.js` | 网页入口：Render 要求服务监听 `0.0.0.0:$PORT`，但 daemon 只肯监听本机（127.0.0.1），所以由它对外提供网页——`/health`（健康检查）、`/connectivity`（连通性测试）、`/login`（扫码登录页）、`/`（操作页：看群聊、发消息）。它只暴露这几个安全接口，daemon 的原始 API（要 token）不对外开放 |
| `bot.js` | （v5 新增）群里自动回消息的机器人：每秒轮询本机 daemon，收到新消息就调 SiliconFlow（免费模型）生成中文回复，图片消息会下载下来用视觉模型看一眼再回。只回群 `45570455225@chatroom` 的消息 |
| `start.sh` | 启动脚本：先起 daemon（本机 6174 端口），再起 bot.js（后台自动回复），最后起 proxy（对外 $PORT） |
| `package.json` | 只是说明文件（Render 用 Dockerfile 部署，不靠它） |
| `render.yaml` | 可选：Render Blueprint，一键建服务用的 |
| `watch.sh` | 只能在 Shell 里用，免费版没有 Shell，所以这个文件用不上，留着不用管 |

## 先说清楚的三个硬伤（部署前必读）

1. **重启就要重新扫码。** Render 免费版没有持久硬盘，容器一重启（重新部署、Render 维护），登录会话就丢了，得重新扫一次码。平时有保活的话重启很少，但这点要接受。
2. **登录会顶掉旧的。** 微信一次只能有一个桌面会话。在这儿扫码登录小号光谱后，原来那台服务器上的微信登录会被顶掉（反正那边的收发本来就是死的）。
3. **封号风险。** agent-wechat 是非官方的逆向协议客户端，腾讯可能封号。所以只用小号光谱，千万别用大号登录。

## 服务对外提供的网页（记住这几个地址）

假设你的服务网址是 `https://agent-wechat-xxxx.onrender.com`（部署完 Render 会给你）：

| 地址 | 作用 |
|---|---|
| `https://你的网址/health` | 健康检查，返回 `{"status":"ok"}` 就是 daemon 在跑；UptimeRobot 保活就 ping 这个 |
| `https://你的网址/connectivity` | 连通性测试，看这台服务器能不能连上微信消息服务器 |
| `https://你的网址/login` | 扫码登录页：显示登录二维码，手机扫码登录小号光谱 |
| `https://你的网址/` | 操作页：看群聊列表、发测试消息、看最近事件 |

> 这个网址只有你知道，别发给别人。谁打开 `/login` 都能触发登录、谁打开操作页都能发消息，所以别把网址公开。

## 第一步：把文件传到 GitHub（用户名 claus978a）

1. 打开 GitHub，点右上角 `+` → `New repository`。
2. Repository name 填 `agent-wechat-render`，选 Public（免费版部署公开仓库最省事；里面没有任何密码和密钥，放心），点 `Create repository`。
3. 在新建的仓库页面点 `uploading an existing file`（或者 `Add file` → `Upload files`），把这个文件夹里的 **全部文件**（Dockerfile、proxy.js、start.sh、package.json、render.yaml、watch.sh、README.md）拖进去，点 `Commit changes`。
4. **注意：文件要直接在仓库根目录，别包在一个文件夹里传。** 如果仓库根目录下只有一个 `render-agent-wechat` 文件夹（没有直接看到 `Dockerfile`），部署会失败。正确的是根目录直接能看到 `Dockerfile`、`proxy.js`、`start.sh`。

## 第二步：在 Render 上建服务（不要卡、不要地址）

1. 打开 https://render.com ，点 `Sign Up`，用 GitHub 登录（或者邮箱注册）。**全程不问银行卡、不问地址。**
2. 登录后点 `New +` → `Web Service`。
3. 选 `Build and deploy from a Git repository` → `Next`，找到并选中你刚建的 `claus978a/agent-wechat-render` 仓库（第一次要授权 Render 访问 GitHub，按提示点 Allow）。
4. 按下面填：
   - **Name**：`agent-wechat`（随便起，记好就行）
   - **Region**：选 `Oregon (US West)`（免费版只有美国区）
   - **Branch**：`main`
   - **Language / Runtime**：`Docker`（Render 检测到 Dockerfile 会自动选；如果它选成了 Node，手动改成 Docker）
   - **Instance Type**：选 `Free`（512MB 内存，免费）
   - 其他不用动，点 `Create Web Service`（或者底部的 `Deploy web service`）。
5. 等部署完成（第一次要几分钟，下载 Node 镜像、装 ffmpeg、下载 wx 程序）。状态变成 `Live` 就是跑起来了。记下服务给你的网址，比如 `https://agent-wechat-xxxx.onrender.com`。
6. 打开 `https://你的网址/health`，应该看到 `{"status":"ok"}`。看到就说明 daemon 在跑。

## 第三步：实测能不能连上微信服务器（必须做，浏览器里做）

打开浏览器访问：

```
https://你的网址/connectivity
```

会返回一段 JSON，关键看 `overall` 和 `long.reachable`：
- `"overall": true`，`long.reachable: true` —— 能连上，继续下一步。
- `"overall": false`，`reachable: false`，detail 里是 `wrong version number` 之类的 —— 说明这条路也走不通，停下来告诉我，别往下走了。

> 这一步替代了原来要在 Shell 里跑的 `openssl` 测试，现在不用 Shell，直接在浏览器里看结果。

## 第四步：登录小号光谱（在浏览器里扫码，不用 Shell）

1. 打开浏览器访问：

   ```
   https://你的网址/login
   ```

2. 页面上会显示一个二维码（如果没显示，点“重新获取二维码”）。**用手机微信扫一扫**（微信里点右上角 + → 扫一扫，对着浏览器里的二维码扫，不要用手机相机直接扫）。
   - 手机必须登着小号 **光谱** 再扫。
   - 手机上出来确认就点确认，页面显示“✅ 已登录”就好了。
   - 二维码几分钟会过期，页面每 15 秒自动刷新一次；过期了点“重新获取二维码”。
   - ⚠️ 扫码成功后，**不要再把这个手机切回大号**，不然电脑这边会掉线。
3. 登录成功后，去操作页验证：打开 `https://你的网址/`，点“刷新群聊”，应该能看到三人群，找到它的 ID（形如 `xxxxx@chatroom`），记下来，后面发消息要用。

## 第五步：防休眠保活（UptimeRobot，免费）

Render 免费版 15 分钟没人访问会自动睡觉，睡了微信就断连。用免费的 UptimeRobot 每 5 分钟叫它一声：

1. 打开 https://uptimerobot.com 注册免费账号（邮箱就行，不要卡）。
2. `Add New Monitor`，按下面填：
   - **Monitor Type**：`HTTP(s)`
   - **Friendly Name**：`agent-wechat`（随便）
   - **URL or IP**：填你 Render 服务的网址 + `/health`，比如 `https://agent-wechat-xxxx.onrender.com/health`
   - **Monitoring Interval**：`5 minutes`
3. 保存。以后它每 5 分钟 ping 一次，服务就不会睡了。

## 平时怎么用（都在浏览器里，不用 Shell）

- **看群聊**：打开 `https://你的网址/`，点“刷新群聊”。
- **发消息**：在操作页填群聊 ID（`xxxxx@chatroom`）和内容，点“发送”。
- **发图片**：调接口 `POST https://你的网址/api/send-image`，body 是 JSON：`{"threadId": "xxxxx@chatroom", "imageBase64": "图片的 base64", "filename": "a.jpg", "mimeType": "image/jpeg"}`（图片最大 10MB）。原理是先把图传给 daemon 再发出去。
- **看最近事件/消息**：操作页点“刷新事件”；要看某个群的消息，用 `https://你的网址/api/messages?thread=xxxxx@chatroom&limit=20`（浏览器直接打开就能看 JSON）。
- **看状态**：`https://你的网址/api/state`（daemon 在不在跑、登没登录）。
- **重新登录**：容器重启后会话丢了，就去 `https://你的网址/login` 重新扫一次码。

## 出问题怎么办

| 现象 | 怎么办 |
|---|---|
| 打开 `/health` 不是 `{"status":"ok"}` | 在 Render 页面点 `Manual Deploy` → `Deploy latest commit` 重新部署；再看日志（`Logs` 标签页） |
| `/connectivity` 显示连不上（`reachable: false`） | 说明 Render 这台机器也连不上微信服务器，这条路走不通，告诉我 |
| `/login` 一直不显示二维码 / 显示“登录失败” | 点“重新获取二维码”；如果反复失败，先去 `/connectivity` 确认网络是通的，再告诉我 |
| 群里收不到消息 / 发不出去 | 先打开 `/connectivity` 确认还能连上微信服务器；再去操作页看群聊列表里有没有那个群 |
| 容器重启后要重新登录 | 正常现象（免费版没硬盘）。去 `/login` 重新扫码就行 |
| 登录时二维码扫出来是网页 | 用微信里的扫一扫，别用手机相机；手机要登着小号光谱；点“重新获取二维码”换个新码再扫 |
| 部署失败（Deploy failed） | 先确认仓库根目录直接有 `Dockerfile`（别包在文件夹里）；再确认 Render 里 Runtime 选的是 `Docker` 不是 `Node`；还不行就把部署日志（Logs）截图发我 |

## v5：机器人自动回消息（SiliconFlow 免费模型）

以前群里的回复是靠另一台服务器每 1.5 秒远程轮询 Render，慢（10–20 秒）还经常断。v5 把回复逻辑搬进了 Render 容器里：`bot.js` 直接在本机轮询 daemon，收到消息就调 SiliconFlow 的免费模型生成回复，文字消息大概 2–3 秒就能回。

**设置密钥（部署前必须做）：**
1. 去 https://cloud.siliconflow.cn 注册登录，左边找到 **API 密钥**，新建一个，复制 `sk-...` 开头的密钥。
2. 在 Render 里打开这个服务 → 左边 **Environment** → 点 **Add Environment Variable**，Key 填 `SILICONFLOW_API_KEY`，Value 粘贴密钥，保存。
3. 再重新部署（`Manual Deploy` → `Deploy latest commit`）。**重新部署会清掉微信登录，部署完去 `/login` 重新扫码。**

**用的模型（都是免费的，可以在 Environment 里改）：**
- 文字：`Qwen/Qwen2.5-7B-Instruct`（环境变量 `SILICONFLOW_MODEL`）
- 看图：`Qwen/Qwen2-VL-7B-Instruct`（环境变量 `SILICONFLOW_VISION_MODEL`，失败时自动换 `Qwen/Qwen2.5-VL-7B-Instruct`）

**注意：** 部署 v5 之后，以前那台服务器上的轮询程序要停掉，不然群里会收到两份回复（一个 Render 发的，一个旧程序发的）。只留 Render 里的 bot.js 回消息。

## 费用

全程 $0：GitHub 免费、Render 免费版、UptimeRobot 免费版。没有任何卡、任何扣费。Render 的 Shell 是付费功能，免费版没有，但本方案全程不用 Shell。
