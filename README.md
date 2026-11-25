# dsh-pwa

给 DeepSeek Harness 0.2.3-alpha.2 的 Web GUI 加一个 **OIDC 安全的 PWA 外壳**：Service Worker、离线兜底、安装为独立应用。

它只做一件事——注入并托管一个 Service Worker。**不覆盖** `/manifest.webmanifest`、`/icons/*` 或首页 HTML：这些 DSH 0.2.3 已经自带（manifest、192/512/maskable 图标、`apple-touch-icon`、`display: standalone`），重复实现只会把本来匿名可取的 manifest 换成一条需要登录的路由，反而让浏览器装不上。

- 适用：DSH `0.2.3-alpha.2`，Web profile，`dsh-oidc`（或任何在 `webserver/request` 里处理 `/auth/*` 的登录插件），以及 TLS 反向代理。
- 不适用：Desktop 外壳、纯 token 启动 URL 的临时调试（仍可用，但 SW 只覆盖 Web GUI）。

## 它加什么

| 能力 | 实现 |
|---|---|
| 安装为应用 | DSH 自带 manifest + 图标；本插件提供 Service Worker，让 Android 的安装入口与独立窗口体验稳定 |
| 离线打开 | 网络优先缓存文档（外壳），缓存优先缓存静态资源（DSH 的资源是内容哈希的） |
| 离线兜底页 | 既没有网络也没有外壳时显示中文离线页 |
| 自动更新 | Service Worker 脚本随插件版本与源码哈希变化；可选 `autoReload` 在更新接管后刷新一次 |

它不碰的东西，正是最容易被缓存毁掉的：`/auth/*`、`/api/*`、`/plugins/*`、`/ws`、`/connect`、`/pairing/*`、`/oauth/*`、`/open-in-app/*`、`/hooks/*`、`/inspector/*`。

## 安装

直接从 GitHub 安装：

```sh
dsh plugin --profile <profile> add github:Allenyou1126/dsh-pwa
```

或用本地 checkout：

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-pwa
```

或在 **Plugins → Add plugin** 填 `github:Allenyou1126/dsh-pwa` / 选择本目录。安装后 `cordis.patch.yml` 会插入 `dsh-pwa` 行；插件没有必填配置，装上即生效。

可选配置（覆盖该行 `config`）：

```yaml
- id: dsh-pwa
  name: dsh-pwa
  config:
    offline: true      # 默认 true；关掉后只保留 SW，不缓存任何请求
    autoReload: false  # 默认 false；true 时 SW 更新接管后刷新一次页面
```

`autoReload` 默认关闭是有意的：OIDC 登录、回调、完成页之间的导航不应被刷新打断。

## 为什么不会破坏 OIDC

DSH 的 `dsh-oidc` 在 `webserver/request` 最前面处理：

- `/auth/login`、`/auth/callback`、`/auth/logout`；
- 未登录时对 `/`、`/index.html` 的 HTML 导航返回 302 到 IdP。

本插件的约定与之严格对齐：

1. **`/auth/*` 完全不拦截**。登录、回调、退出都是浏览器原生顶层导航，`Sec-Fetch-Site`、302、`Set-Cookie` 全部按登录插件的预期工作。
2. **导航网络优先，只缓存“同源 + 200 + 未被重定向 + 非 `no-store`”的响应**。未登录时 `/` 的响应最终落在 IdP 域上（跨域、opaque 或 `redirected`），一律不入缓存，所以**永远不会把 IdP 登录页或 401 页当成离线外壳**。
3. **`/auth/logout` 顺手清空缓存**。退出后不会留下上一会话的已认证页面。
4. **不预缓存 `/`**。首页需要 OIDC 会话，任何“安装时预取首页”的做法都会在未登录时失败；外壳只在第一次成功登录后按需缓存。
5. 浏览器对 `<link rel="manifest">` 的抓取默认不带 Cookie，所以 manifest、图标、`sw.js` 都必须匿名可达；本插件只注册匿名的 `/sw.js`，manifest 与图标继续由 DSH 的匿名 fallback 提供。

已在 Chrome 实测：SW 控制页面时，`/` → `/auth/login` → 跨域 IdP 页 → 回调 → 完成页 → `/` 全链路正常；登录后离线重载能打开缓存的外壳；`/auth/*` 从不出现在 Cache Storage；退出后缓存为空。

## 反向代理要求

以挂载在 `https://app.example.com/ui/` 为例：

```sh
dsh --profile web --public-url https://app.example.com/ui/ --trusted-host app.example.com
```

- **保留 `Host`**：`dsh-oidc` 的回调与 Cookie 都按公开 Host 校验。
- **剥离前缀**：DSH 监听端只认根路径；`/ui/auth/callback` 必须到达 DSH 的 `/auth/callback`。
- **转发 Upgrade**：WebSocket 不能被代理吞掉。
- **TLS 终止在代理上**：Service Worker 只在安全上下文生效（`localhost` 除外），`dsh-oidc` 也要求 HTTPS。
- **不要缓存 `/auth/*` 与 `/sw.js`**，也不要在代理层给 manifest、图标、`sw.js` 加登录拦截——浏览器取 manifest 时不带 Cookie。
- `/ui` 要重定向到 `/ui/`，否则页面相对路径与 SW scope 会落到错误目录。

nginx 片段：

```nginx
location /ui/ {
    proxy_pass http://127.0.0.1:3080/;   # 结尾斜杠 = 剥离 /ui/
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;

    # 登录与 worker 一律不缓存
    proxy_no_cache 1;
    proxy_cache_bypass 1;
    add_header Cache-Control "no-store" always;
}

location = /ui { return 301 /ui/; }
```

插件内部全部使用**相对路径**：`register('./sw.js', { scope: './' })`。所以挂在 `/`、`/ui/` 还是更深的前缀都不需要改插件；SW 的 bypass 判断也先按 `registration.scope` 去掉前缀再匹配。

## 验证清单

1. `https://app.example.com/ui/` 登录后打开 DevTools → **Application → Service Workers**：`/ui/sw.js` 为 activated and running。
2. **Application → Manifest**：读取到 DSH 自带 manifest（名称、图标、`display: standalone`），无红色报错。
3. 地址栏出现安装图标（或 Android 菜单“安装应用”）；安装后以独立窗口打开，落到 `/ui/`，需要时继续走 OIDC。
4. DevTools → Network 勾选 Offline 后刷新：出现缓存的外壳；未缓存时出现“当前离线”页。
5. **Application → Cache Storage**：只有 `dsh-pwa-<version>-<hash>`，里面不应出现 `auth`、`api`、`plugins` 路径。
6. 退出（访问 `/auth/logout`）后：Cache Storage 清空，再次打开会重新走 OIDC。

## 限制

- **只缓存外壳**：DSH 是实时应用，离线时 API/WebSocket 不可用；离线页只是兜底，不是可用的离线模式。
- **缓存的是已认证页面**：同一浏览器/来源下共享，退出即清；不要在共享设备上把离线缓存当作安全边界。
- **iOS** 的安装入口在分享菜单（“添加到主屏幕”），由 DSH 自带的 `apple-touch-icon` 与 `apple-mobile-web-app-capable` 提供；Service Worker 生效但独立窗口行为由系统决定。
- **`autoReload` 打开后**，SW 更新接管会刷新一次页面；如果恰好在 OIDC 回调中途，可能打断一次登录（重新点一次即可）。默认关闭。
- 插件不提供多标签会话协调、后台同步、推送。

## 开发与测试

```sh
cd dsh-pwa
node --check src/*.js
node --test test/*.test.js   # 20 个用例：路由、注入、bypass、缓存判定、退出清理、前缀 scope
```

测试用 `node:vm` 在假 `self`/`caches`/`fetch` 上运行真实的 `src/sw.js`，覆盖：

- `/auth/*`、`/api/*`、`/plugins/*`、WebSocket upgrade 一律直通；
- 登录后的 `/` 被缓存且离线可回放；
- IdP 跨域/重定向响应永不入缓存；
- `Cache-Control: no-store` 不入缓存；
- 静态资源缓存优先；
- `/auth/logout` 清空缓存；
- 挂载前缀下 bypass 判定正确。
